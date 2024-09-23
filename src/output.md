path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/browser-action.ts
```ts
import { Menu, MenuItem, protocol, nativeImage, app } from 'electron'
import { ExtensionContext } from '../context'
import { PopupView } from '../popup'
import { ExtensionEvent } from '../router'
import {
  getExtensionUrl,
  getExtensionManifest,
  getIconPath,
  resolveExtensionPath,
  matchSize,
  ResizeType,
} from './common'

const debug = require('debug')('electron-chrome-extensions:browserAction')

if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([{ scheme: 'crx', privileges: { bypassCSP: true } }])
}

interface ExtensionAction {
  color?: string
  text?: string
  title?: string
  icon?: chrome.browserAction.TabIconDetails
  popup?: string
  /** Last modified date for icon. */
  iconModified?: number
}

type ExtensionActionKey = keyof ExtensionAction

interface ActivateDetails {
  eventType: string
  extensionId: string
  tabId: number
  anchorRect: { x: number; y: number; width: number; height: number }
}

const getBrowserActionDefaults = (extension: Electron.Extension): ExtensionAction | undefined => {
  const manifest = getExtensionManifest(extension)
  const { browser_action } = manifest
  if (typeof browser_action === 'object') {
    const action: ExtensionAction = {}

    action.title = browser_action.default_title || manifest.name

    const iconPath = getIconPath(extension)
    if (iconPath) action.icon = { path: iconPath }

    if (browser_action.default_popup) {
      action.popup = browser_action.default_popup
    }

    return action
  }
}

interface ExtensionActionStore extends Partial<ExtensionAction> {
  tabs: { [key: string]: ExtensionAction }
}

export class BrowserActionAPI {
  private actionMap = new Map</* extensionId */ string, ExtensionActionStore>()
  private popup?: PopupView

  private observers: Set<Electron.WebContents> = new Set()
  private queuedUpdate: boolean = false

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    const getter =
      (propName: ExtensionActionKey) =>
      ({ extension }: ExtensionEvent, details: chrome.browserAction.TabDetails = {}) => {
        const { tabId } = details
        const action = this.getAction(extension.id)

        let result

        if (tabId) {
          if (action.tabs[tabId]) {
            result = action.tabs[tabId][propName]
          } else {
            result = action[propName]
          }
        } else {
          result = action[propName]
        }

        return result
      }

    const setDetails = (
      { extension }: ExtensionEvent,
      details: any,
      propName: ExtensionActionKey
    ) => {
      const { tabId } = details
      let value = (details as any)[propName] || undefined

      if (typeof value === 'undefined') {
        const defaults = getBrowserActionDefaults(extension)
        value = defaults ? defaults[propName] : value
      }

      const valueObj = { [propName]: value }
      const action = this.getAction(extension.id)

      if (tabId) {
        const tabAction = action.tabs[tabId] || (action.tabs[tabId] = {})
        Object.assign(tabAction, valueObj)
      } else {
        Object.assign(action, valueObj)
      }

      this.onUpdate()
    }

    const setter =
      (propName: ExtensionActionKey) =>
      (event: ExtensionEvent, details: chrome.browserAction.TabDetails) =>
        setDetails(event, details, propName)

    const handleProp = (prop: string, key: ExtensionActionKey) => {
      handle(`browserAction.get${prop}`, getter(key))
      handle(`browserAction.set${prop}`, setter(key))
    }

    handleProp('BadgeBackgroundColor', 'color')
    handleProp('BadgeText', 'text')
    handleProp('Title', 'title')
    handleProp('Popup', 'popup')

    // setIcon is unique in that it can pass in a variety of properties. Here we normalize them
    // to use 'icon'.
    handle(
      'browserAction.setIcon',
      (event, { tabId, ...details }: chrome.browserAction.TabIconDetails) => {
        setDetails(event, { tabId, icon: details }, 'icon')
        setDetails(event, { tabId, iconModified: Date.now() }, 'iconModified')
      }
    )

    // browserAction preload API
    const preloadOpts = { allowRemote: true, extensionContext: false }
    handle('browserAction.getState', this.getState.bind(this), preloadOpts)
    handle('browserAction.activate', this.activate.bind(this), preloadOpts)
    handle(
      'browserAction.addObserver',
      (event) => {
        const { sender: webContents } = event
        this.observers.add(webContents)
        webContents.once('destroyed', () => {
          this.observers.delete(webContents)
        })
      },
      preloadOpts
    )
    handle(
      'browserAction.removeObserver',
      (event) => {
        const { sender: webContents } = event
        this.observers.delete(webContents)
      },
      preloadOpts
    )

    this.ctx.store.on('active-tab-changed', () => {
      this.onUpdate()
    })

    // Clear out tab details when removed
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const [, actionDetails] of this.actionMap) {
        if (actionDetails.tabs[tabId]) {
          delete actionDetails.tabs[tabId]
        }
      }
      this.onUpdate()
    })

    this.setupSession(this.ctx.session)
  }

  private setupSession(session: Electron.Session) {
    session.on('extension-loaded', (event, extension) => {
      this.processExtension(extension)
    })

    session.on('extension-unloaded', (event, extension) => {
      this.removeActions(extension.id)
    })

    session.protocol.registerBufferProtocol('crx', this.handleCrxRequest)
  }

  private handleCrxRequest = (
    request: Electron.ProtocolRequest,
    callback: (response: Electron.ProtocolResponse) => void
  ) => {
    debug('%s', request.url)

    let response: Electron.ProtocolResponse

    try {
      const url = new URL(request.url)
      const { hostname: requestType } = url

      switch (requestType) {
        case 'extension-icon': {
          const tabId = url.searchParams.get('tabId')

          const fragments = url.pathname.split('/')
          const extensionId = fragments[1]
          const imageSize = parseInt(fragments[2], 10)
          const resizeType = parseInt(fragments[3], 10) || ResizeType.Up

          const extension = this.ctx.session.getExtension(extensionId)

          let iconDetails: chrome.browserAction.TabIconDetails | undefined

          const action = this.actionMap.get(extensionId)
          if (action) {
            iconDetails = (tabId && action.tabs[tabId]?.icon) || action.icon
          }

          let iconImage

          if (extension && iconDetails) {
            if (typeof iconDetails.path === 'string') {
              const iconAbsPath = resolveExtensionPath(extension, iconDetails.path)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.path === 'object') {
              const imagePath = matchSize(iconDetails.path, imageSize, resizeType)
              const iconAbsPath = imagePath && resolveExtensionPath(extension, imagePath)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.imageData === 'string') {
              iconImage = nativeImage.createFromDataURL(iconDetails.imageData)
            } else if (typeof iconDetails.imageData === 'object') {
              const imageData = matchSize(iconDetails.imageData as any, imageSize, resizeType)
              iconImage = imageData ? nativeImage.createFromDataURL(imageData) : undefined
            }
          }

          if (iconImage) {
            response = {
              statusCode: 200,
              mimeType: 'image/png',
              data: iconImage.toPNG(),
            }
          } else {
            response = { statusCode: 400 }
          }

          break
        }
        default: {
          response = { statusCode: 400 }
        }
      }
    } catch (e) {
      console.error(e)

      response = {
        statusCode: 500,
      }
    }

    callback(response)
  }

  private getAction(extensionId: string) {
    let action = this.actionMap.get(extensionId)
    if (!action) {
      action = { tabs: {} }
      this.actionMap.set(extensionId, action)
      this.onUpdate()
    }

    return action
  }

  // TODO: Make private for v4 major release.
  removeActions(extensionId: string) {
    if (this.actionMap.has(extensionId)) {
      this.actionMap.delete(extensionId)
    }

    this.onUpdate()
  }

  private getPopupUrl(extensionId: string, tabId: number) {
    const action = this.getAction(extensionId)
    const popupPath = action.tabs[tabId]?.popup || action.popup || undefined

    let url: string | undefined

    // Allow absolute URLs
    try {
      url = popupPath && new URL(popupPath).href
    } catch {}

    // Fallback to relative path
    if (!url) {
      try {
        url = popupPath && new URL(popupPath, `chrome-extension://${extensionId}`).href
      } catch {}
    }

    return url
  }

  // TODO: Make private for v4 major release.
  processExtension(extension: Electron.Extension) {
    const defaultAction = getBrowserActionDefaults(extension)
    if (defaultAction) {
      const action = this.getAction(extension.id)
      Object.assign(action, defaultAction)
    }
  }

  private getState() {
    // Get state without icon data.
    const actions = Array.from(this.actionMap.entries()).map(([id, details]) => {
      const { icon, tabs, ...rest } = details

      const tabsInfo: { [key: string]: any } = {}

      for (const tabId of Object.keys(tabs)) {
        const { icon, ...rest } = tabs[tabId]
        tabsInfo[tabId] = rest
      }

      return {
        id,
        tabs: tabsInfo,
        ...rest,
      }
    })

    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()
    return { activeTabId: activeTab?.id, actions }
  }

  private activate({ sender }: ExtensionEvent, details: ActivateDetails) {
    const { eventType, extensionId, tabId } = details

    debug(
      `activate [eventType: ${eventType}, extensionId: '${extensionId}', tabId: ${tabId}, senderId: ${sender.id}]`
    )

    switch (eventType) {
      case 'click':
        this.activateClick(details)
        break
      case 'contextmenu':
        this.activateContextMenu(details)
        break
      default:
        console.debug(`Ignoring unknown browserAction.activate event '${eventType}'`)
    }
  }

  private activateClick(details: ActivateDetails) {
    const { extensionId, tabId, anchorRect } = details

    if (this.popup) {
      const toggleExtension = !this.popup.isDestroyed() && this.popup.extensionId === extensionId
      this.popup.destroy()
      this.popup = undefined
      if (toggleExtension) {
        debug('skipping activate to close popup')
        return
      }
    }

    const tab =
      tabId >= 0 ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) {
      throw new Error(`Unable to get active tab`)
    }

    const popupUrl = this.getPopupUrl(extensionId, tab.id)

    if (popupUrl) {
      const win = this.ctx.store.tabToWindow.get(tab)
      if (!win) {
        throw new Error('Unable to get BrowserWindow from active tab')
      }

      this.popup = new PopupView({
        extensionId,
        session: this.ctx.session,
        parent: win,
        url: popupUrl,
        anchorRect,
      })

      debug(`opened popup: ${popupUrl}`)

      this.ctx.emit('browser-action-popup-created', this.popup)
    } else {
      debug(`dispatching onClicked for ${extensionId}`)

      const tabDetails = this.ctx.store.tabDetailsCache.get(tab.id)
      this.ctx.router.sendEvent(extensionId, 'browserAction.onClicked', tabDetails)
    }
  }

  private activateContextMenu(details: ActivateDetails) {
    const { extensionId, anchorRect } = details

    const extension = this.ctx.session.getExtension(extensionId)
    if (!extension) {
      throw new Error(`Unregistered extension '${extensionId}'`)
    }

    const manifest = getExtensionManifest(extension)
    const menu = new Menu()
    const append = (opts: Electron.MenuItemConstructorOptions) => menu.append(new MenuItem(opts))
    const appendSeparator = () => menu.append(new MenuItem({ type: 'separator' }))

    append({
      label: extension.name,
      click: () => {
        const homePageUrl =
          manifest.homepage_url || `https://chrome.google.com/webstore/detail/${extension.id}`
        this.ctx.store.createTab({ url: homePageUrl })
      },
    })

    appendSeparator()

    const contextMenuItems: MenuItem[] = this.ctx.store.buildMenuItems(
      extensionId,
      'browser_action'
    )
    if (contextMenuItems.length > 0) {
      contextMenuItems.forEach((item) => menu.append(item))
      appendSeparator()
    }

    const optionsPage = manifest.options_page || manifest.options_ui?.page
    const optionsPageUrl = optionsPage ? getExtensionUrl(extension, optionsPage) : undefined

    append({
      label: 'Options',
      enabled: typeof optionsPageUrl === 'string',
      click: () => {
        this.ctx.store.createTab({ url: optionsPageUrl })
      },
    })

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG) {
      append({
        label: 'Remove extension',
        click: () => {
          debug(`removing extension "${extension.name}" (${extension.id})`)
          this.ctx.session.removeExtension(extension.id)
        },
      })
    }

    menu.popup({
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height),
    })
  }

  private onUpdate() {
    if (this.queuedUpdate) return
    this.queuedUpdate = true
    queueMicrotask(() => {
      this.queuedUpdate = false
      debug(`dispatching update to ${this.observers.size} observer(s)`)
      Array.from(this.observers).forEach((observer) => {
        if (!observer.isDestroyed()) {
          observer.send('browserAction.update')
        }
      })
    })
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/commands.ts
```ts
import { ExtensionContext } from '../context'

/**
 * Stub implementation for chrome.commands API.
 */
export class CommandsAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('commands.getAll', this.getAll)
  }

  getAll() {
    return []
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/common.ts
```ts
import { promises as fs } from 'fs'
import * as path from 'path'
import { nativeImage } from 'electron'

export interface TabContents extends Electron.WebContents {
  favicon?: string
}

export type ContextMenuType =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio'
  | 'launcher'
  | 'browser_action'
  | 'page_action'
  | 'action'

/**
 * Get the extension's properly typed Manifest.
 *
 * I can't seem to get TS's merged type declarations working so I'm using this
 * instead for now.
 */
export const getExtensionManifest = (extension: Electron.Extension): chrome.runtime.Manifest =>
  extension.manifest

export const getExtensionUrl = (extension: Electron.Extension, uri: string) => {
  try {
    return new URL(uri, extension.url).href
  } catch {}
}

export const resolveExtensionPath = (extension: Electron.Extension, uri: string) => {
  const resPath = path.join(extension.path, uri)

  // prevent any parent traversals
  if (!resPath.startsWith(extension.path)) return

  return resPath
}

export const validateExtensionResource = async (extension: Electron.Extension, uri: string) => {
  const resPath = resolveExtensionPath(extension, uri)
  if (!resPath) return

  try {
    await fs.stat(resPath)
  } catch {
    return // doesn't exist
  }

  return resPath
}

export enum ResizeType {
  Exact,
  Up,
  Down,
}

export const matchSize = (
  imageSet: { [key: number]: string },
  size: number,
  match: ResizeType
): string | undefined => {
  // TODO: match based on size
  const first = parseInt(Object.keys(imageSet).pop()!, 10)
  return imageSet[first]
}

/** Gets the relative path to the extension's default icon. */
export const getIconPath = (
  extension: Electron.Extension,
  iconSize: number = 32,
  resizeType = ResizeType.Up
) => {
  const { browser_action, icons } = getExtensionManifest(extension)
  const { default_icon } = browser_action || {}

  if (typeof default_icon === 'string') {
    const iconPath = default_icon
    return iconPath
  } else if (typeof default_icon === 'object') {
    const iconPath = matchSize(default_icon, iconSize, resizeType)
    return iconPath
  } else if (typeof icons === 'object') {
    const iconPath = matchSize(icons, iconSize, resizeType)
    return iconPath
  }
}

export const getIconImage = (extension: Electron.Extension) => {
  const iconPath = getIconPath(extension)
  const iconAbsolutePath = iconPath && resolveExtensionPath(extension, iconPath)
  return iconAbsolutePath ? nativeImage.createFromPath(iconAbsolutePath) : undefined
}

const escapePattern = (pattern: string) => pattern.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')

/**
 * @see https://developer.chrome.com/extensions/match_patterns
 */
export const matchesPattern = (pattern: string, url: string) => {
  if (pattern === '<all_urls>') return true
  const regexp = new RegExp(`^${pattern.split('*').map(escapePattern).join('.*')}$`)
  return url.match(regexp)
}

export const matchesTitlePattern = (pattern: string, title: string) => {
  const regexp = new RegExp(`^${pattern.split('*').map(escapePattern).join('.*')}$`)
  return title.match(regexp)
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/context-menus.ts
```ts
import { Menu, MenuItem } from 'electron'
import { MenuItemConstructorOptions } from 'electron/main'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ContextMenuType, getIconImage, matchesPattern } from './common'

type ContextItemProps = chrome.contextMenus.CreateProperties & { id: string }

type ContextItemConstructorOptions = {
  extension: Electron.Extension
  props: ContextItemProps
  webContents: Electron.WebContents
  params?: Electron.ContextMenuParams
  showIcon?: boolean
}

const DEFAULT_CONTEXTS = ['page']

const getContextTypesFromParams = (params: Electron.ContextMenuParams): Set<ContextMenuType> => {
  const contexts = new Set<ContextMenuType>(['all'])

  switch (params.mediaType) {
    case 'audio':
    case 'video':
    case 'image':
      contexts.add(params.mediaType)
  }

  if (params.pageURL) contexts.add('page')
  if (params.linkURL) contexts.add('link')
  if (params.frameURL) contexts.add('frame')
  if (params.selectionText) contexts.add('selection')
  if (params.isEditable) contexts.add('editable')

  return contexts
}

const formatTitle = (title: string, params: Electron.ContextMenuParams) => {
  if (params.selectionText && title.includes('%s')) {
    title = title.split('%s').join(params.selectionText)
  }
  return title
}

const matchesConditions = (
  props: ContextItemProps,
  conditions: {
    contextTypes: Set<ContextMenuType>
    targetUrl?: string
    documentUrl?: string
  }
) => {
  if (props.visible === false) return false

  const { contextTypes, targetUrl, documentUrl } = conditions

  const contexts = props.contexts || DEFAULT_CONTEXTS
  const inContext = contexts.some((context) => contextTypes.has(context as ContextMenuType))
  if (!inContext) return false

  if (props.targetUrlPatterns && props.targetUrlPatterns.length > 0 && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => matchesPattern(pattern, targetUrl))) {
      return false
    }
  }

  if (props.documentUrlPatterns && props.documentUrlPatterns.length > 0 && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => matchesPattern(pattern, documentUrl))) {
      return false
    }
  }

  return true
}

export class ContextMenusAPI {
  private menus = new Map<
    /* extensionId */ string,
    Map</* menuItemId */ string, ContextItemProps>
  >()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('contextMenus.create', this.create)
    handle('contextMenus.remove', this.remove)
    handle('contextMenus.removeAll', this.removeAll)

    this.ctx.session.on('extension-unloaded', (event, extension) => {
      if (this.menus.has(extension.id)) {
        this.menus.delete(extension.id)
      }
    })

    this.ctx.store.buildMenuItems = this.buildMenuItemsForExtension.bind(this)
  }

  private addContextItem(extensionId: string, props: ContextItemProps) {
    let contextItems = this.menus.get(extensionId)
    if (!contextItems) {
      contextItems = new Map()
      this.menus.set(extensionId, contextItems)
    }
    contextItems.set(props.id, props)
  }

  private buildMenuItem = (opts: ContextItemConstructorOptions) => {
    const { extension, props, webContents, params } = opts

    // TODO: try to get the appropriately sized image before resizing
    let icon = opts.showIcon ? getIconImage(extension) : undefined
    if (icon) {
      icon = icon.resize({ width: 16, height: 16 })
    }

    const menuItemOptions: MenuItemConstructorOptions = {
      id: props.id,
      type: props.type as any,
      label: params ? formatTitle(props.title || '', params) : props.title || '',
      icon,
      enabled: props.enabled,
      click: () => {
        this.onClicked(extension.id, props.id, webContents, params)
      },
    }

    return menuItemOptions
  }

  private buildMenuItemsFromTemplate = (menuItemTemplates: ContextItemConstructorOptions[]) => {
    const itemMap = new Map<string, MenuItemConstructorOptions>()

    // Group by ID
    for (const item of menuItemTemplates) {
      const menuItem = this.buildMenuItem(item)
      itemMap.set(item.props.id, menuItem)
    }

    // Organize in tree
    for (const item of menuItemTemplates) {
      const menuItem = itemMap.get(item.props.id)
      if (item.props.parentId) {
        const parentMenuItem = itemMap.get(item.props.parentId)
        if (parentMenuItem) {
          const submenu = (parentMenuItem.submenu || []) as Electron.MenuItemConstructorOptions[]
          submenu.push(menuItem!)
          parentMenuItem.submenu = submenu
        }
      }
    }

    const menuItems: Electron.MenuItem[] = []

    const buildFromTemplate = (opts: Electron.MenuItemConstructorOptions) => {
      if (Array.isArray(opts.submenu)) {
        const submenu = new Menu()
        opts.submenu.forEach((item) => submenu.append(buildFromTemplate(item)))
        opts.submenu = submenu
      }
      return new MenuItem(opts)
    }

    // Build all final MenuItems in-order
    for (const item of menuItemTemplates) {
      // Items with parents will be handled recursively
      if (item.props.parentId) continue

      const menuItem = itemMap.get(item.props.id)!
      menuItems.push(buildFromTemplate(menuItem))
    }

    return menuItems
  }

  buildMenuItemsForParams(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams
  ): Electron.MenuItem[] {
    if (webContents.session !== this.ctx.session) return []

    let menuItemOptions: ContextItemConstructorOptions[] = []

    const conditions = {
      contextTypes: getContextTypesFromParams(params),
      targetUrl: params.srcURL || params.linkURL,
      documentUrl: params.frameURL || params.pageURL,
    }

    for (const [extensionId, propItems] of this.menus) {
      const extension = this.ctx.session.getExtension(extensionId)
      if (!extension) continue

      const extensionMenuItemOptions: ContextItemConstructorOptions[] = []

      for (const [, props] of propItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = {
            extension,
            props,
            webContents,
            params,
          }
          extensionMenuItemOptions.push(menuItem)
        }
      }

      const topLevelItems = extensionMenuItemOptions.filter((opt) => !opt.props.parentId)

      if (topLevelItems.length > 1) {
        // Create new top-level item to group children
        const groupId = `group${extension.id}`
        const groupMenuItemOptions: ContextItemConstructorOptions = {
          extension,
          webContents,
          props: {
            id: groupId,
            title: extension.name,
          },
          params,
          showIcon: true,
        }

        // Reassign children to group item
        const children = extensionMenuItemOptions.map((opt) =>
          opt.props.parentId
            ? opt
            : {
                ...opt,
                props: {
                  ...opt.props,
                  parentId: groupId,
                },
              }
        )

        menuItemOptions = [...menuItemOptions, groupMenuItemOptions, ...children]
      } else if (extensionMenuItemOptions.length > 0) {
        // Set all children to show icon
        const children = extensionMenuItemOptions.map((opt) => ({ ...opt, showIcon: true }))
        menuItemOptions = [...menuItemOptions, ...children]
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private buildMenuItemsForExtension(
    extensionId: string,
    menuType: ContextMenuType
  ): Electron.MenuItem[] {
    const extensionItems = this.menus.get(extensionId)
    const extension = this.ctx.session.getExtension(extensionId)
    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()

    const menuItemOptions = []

    if (extensionItems && extension && activeTab) {
      const conditions = {
        contextTypes: new Set<ContextMenuType>(['all', menuType]),
      }

      for (const [, props] of extensionItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = { extension, props, webContents: activeTab }
          menuItemOptions.push(menuItem)
        }
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private create = ({ extension }: ExtensionEvent, createProperties: ContextItemProps) => {
    const { id, type, title } = createProperties

    if (this.menus.has(id)) {
      // TODO: duplicate error
      return
    }

    if (!title && type !== 'separator') {
      // TODO: error
      return
    }

    this.addContextItem(extension.id, createProperties)
  }

  private remove = ({ extension }: ExtensionEvent, menuItemId: string) => {
    const items = this.menus.get(extension.id)
    if (items && items.has(menuItemId)) {
      items.delete(menuItemId)
      if (items.size === 0) {
        this.menus.delete(extension.id)
      }
    }
  }

  private removeAll = ({ extension }: ExtensionEvent) => {
    this.menus.delete(extension.id)
  }

  private onClicked(
    extensionId: string,
    menuItemId: string,
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams
  ) {
    if (webContents.isDestroyed()) return

    const tab = this.ctx.store.tabDetailsCache.get(webContents.id)
    if (!tab) {
      console.error(`[Extensions] Unable to find tab for id=${webContents.id}`)
      return
    }

    const data: chrome.contextMenus.OnClickData = {
      selectionText: params?.selectionText,
      checked: false, // TODO
      menuItemId,
      frameId: -1, // TODO: match frameURL with webFrameMain in Electron 12
      frameUrl: params?.frameURL,
      editable: params?.isEditable || false,
      mediaType: params?.mediaType,
      wasChecked: false, // TODO
      pageUrl: params?.pageURL as any, // types are inaccurate
      linkUrl: params?.linkURL,
      parentMenuItemId: -1, // TODO
      srcUrl: params?.srcURL,
    }

    this.ctx.router.sendEvent(extensionId, 'contextMenus.onClicked', data, tab)
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/cookies.ts
```ts
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

enum CookieStoreID {
  Default = '0',
  Incognito = '1',
}

const onChangedCauseTranslation: { [key: string]: string } = {
  'expired-overwrite': 'expired_overwrite',
}

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
  ...cookie,
  domain: cookie.domain || '',
  hostOnly: Boolean(cookie.hostOnly),
  session: Boolean(cookie.session),
  path: cookie.path || '',
  httpOnly: Boolean(cookie.httpOnly),
  secure: Boolean(cookie.secure),
  storeId: CookieStoreID.Default,
})

export class CookiesAPI {
  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('cookies.get', this.get.bind(this))
    handle('cookies.getAll', this.getAll.bind(this))
    handle('cookies.set', this.set.bind(this))
    handle('cookies.remove', this.remove.bind(this))
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this))

    this.cookies.addListener('changed', this.onChanged)
  }

  private async get(
    event: ExtensionEvent,
    details: chrome.cookies.Details
  ): Promise<chrome.cookies.Cookie | null> {
    // TODO: storeId
    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
    })

    // TODO: If more than one cookie of the same name exists for the given URL,
    // the one with the longest path will be returned. For cookies with the
    // same path length, the cookie with the earliest creation time will be returned.
    return cookies.length > 0 ? createCookieDetails(cookies[0]) : null
  }

  private async getAll(
    event: ExtensionEvent,
    details: chrome.cookies.GetAllDetails
  ): Promise<chrome.cookies.Cookie[]> {
    // TODO: storeId
    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
      domain: details.domain,
      path: details.path,
      secure: details.secure,
      session: details.session,
    })

    return cookies.map(createCookieDetails)
  }

  private async set(
    event: ExtensionEvent,
    details: chrome.cookies.SetDetails
  ): Promise<chrome.cookies.Cookie | null> {
    await this.cookies.set(details)
    const cookies = await this.cookies.get(details)
    return cookies.length > 0 ? createCookieDetails(cookies[0]) : null
  }

  private async remove(
    event: ExtensionEvent,
    details: chrome.cookies.Details
  ): Promise<chrome.cookies.Details | null> {
    try {
      await this.cookies.remove(details.url, details.name)
    } catch {
      return null
    }
    return details
  }

  private async getAllCookieStores(event: ExtensionEvent): Promise<chrome.cookies.CookieStore[]> {
    const tabIds = Array.from(this.ctx.store.tabs)
      .map((tab) => (tab.isDestroyed() ? undefined : tab.id))
      .filter(Boolean) as number[]
    return [{ id: CookieStoreID.Default, tabIds }]
  }

  private onChanged = (event: Electron.Event, cookie: Electron.Cookie, cause: string, removed: boolean) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: onChangedCauseTranslation[cause] || cause,
      cookie: createCookieDetails(cookie),
      removed,
    }

    this.ctx.router.broadcastEvent('cookies.onChanged', changeInfo)
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/notifications.ts
```ts
import { app, Extension, Notification } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { validateExtensionResource } from './common'

enum TemplateType {
  Basic = 'basic',
  Image = 'image',
  List = 'list',
  Progress = 'progress',
}

const getBody = (opts: chrome.notifications.NotificationOptions) => {
  const { type = TemplateType.Basic } = opts

  switch (type) {
    case TemplateType.List: {
      if (!Array.isArray(opts.items)) {
        throw new Error('List items must be provided for list type')
      }
      return opts.items.map((item) => `${item.title} - ${item.message}`).join('\n')
    }
    default:
      return opts.message || ''
  }
}

const getUrgency = (
  priority?: number
): Required<Electron.NotificationConstructorOptions>['urgency'] => {
  if (typeof priority !== 'number') {
    return 'normal'
  } else if (priority >= 2) {
    return 'critical'
  } else if (priority < 0) {
    return 'low'
  } else {
    return 'normal'
  }
}

const createScopedIdentifier = (extension: Extension, id: string) => `${extension.id}-${id}`
const stripScopeFromIdentifier = (id: string) => {
  const index = id.indexOf('-')
  return id.substr(index + 1)
}

export class NotificationsAPI {
  private registry = new Map<string, Notification>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('notifications.clear', this.clear)
    handle('notifications.create', this.create)
    handle('notifications.getAll', this.getAll)
    handle('notifications.getPermissionLevel', this.getPermissionLevel)
    handle('notifications.update', this.update)

    this.ctx.session.on('extension-unloaded', (event, extension) => {
      for (const [key, notification] of this.registry) {
        if (key.startsWith(extension.id)) {
          notification.close()
        }
      }
    })
  }

  private clear = ({ extension }: ExtensionEvent, id: string) => {
    const notificationId = createScopedIdentifier(extension, id)
    if (this.registry.has(notificationId)) {
      this.registry.get(notificationId)?.close()
    }
  }

  private create = async ({ extension }: ExtensionEvent, arg1: unknown, arg2?: unknown) => {
    let id: string
    let opts: chrome.notifications.NotificationOptions

    if (typeof arg1 === 'object') {
      id = 'guid' // TODO: generate uuid
      opts = arg1 as chrome.notifications.NotificationOptions
    } else if (typeof arg1 === 'string') {
      id = arg1
      opts = arg2 as chrome.notifications.NotificationOptions
    } else {
      throw new Error('Invalid arguments')
    }

    if (typeof opts !== 'object' || !opts.type || !opts.iconUrl || !opts.title || !opts.message) {
      throw new Error('Missing required notification options')
    }

    const notificationId = createScopedIdentifier(extension, id)

    if (this.registry.has(notificationId)) {
      this.registry.get(notificationId)?.close()
    }

    let icon

    if (opts.iconUrl) {
      let url
      try {
        url = new URL(opts.iconUrl)
      } catch {}

      if (url?.protocol === 'data:') {
        icon = opts.iconUrl
      } else {
        icon = await validateExtensionResource(extension, opts.iconUrl)
      }

      if (!icon) {
        throw new Error('Invalid iconUrl')
      }
    }

    // TODO: buttons, template types

    const notification = new Notification({
      title: opts.title,
      subtitle: app.name,
      body: getBody(opts),
      silent: opts.silent,
      icon,
      urgency: getUrgency(opts.priority),
      timeoutType: opts.requireInteraction ? 'never' : 'default',
    })

    this.registry.set(notificationId, notification)

    notification.on('click', () => {
      this.ctx.router.sendEvent(extension.id, 'notifications.onClicked', id)
    })

    notification.once('close', () => {
      const byUser = true // TODO
      this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, byUser)
      this.registry.delete(notificationId)
    })

    notification.show()

    return id
  }

  private getAll = ({ extension }: ExtensionEvent) => {
    return Array.from(this.registry.keys())
      .filter((key) => key.startsWith(extension.id))
      .map(stripScopeFromIdentifier)
  }

  private getPermissionLevel = (event: ExtensionEvent) => {
    return Notification.isSupported() ? 'granted' : 'denied'
  }

  private update = (
    { extension }: ExtensionEvent,
    id: string,
    opts: chrome.notifications.NotificationOptions
  ) => {
    const notificationId = createScopedIdentifier(extension, id)

    const notification = this.registry.get(notificationId)

    if (!notification) {
      return false
    }

    // TODO: remaining opts

    if (opts.priority) notification.urgency = getUrgency(opts.priority)
    if (opts.silent) notification.silent = opts.silent
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/runtime.ts
```ts
import { EventEmitter } from 'events'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'

export class RuntimeAPI extends EventEmitter {
  constructor(private ctx: ExtensionContext) {
    super()

    const handle = this.ctx.router.apiHandler()
    handle('runtime.openOptionsPage', this.openOptionsPage)
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    // TODO: options page shouldn't appear in Tabs API
    // https://developer.chrome.com/extensions/options#tabs-api

    const manifest = getExtensionManifest(extension)

    if (manifest.options_ui) {
      // Embedded option not support (!options_ui.open_in_new_tab)
      const url = `chrome-extension://${extension.id}/${manifest.options_ui.page}`
      await this.ctx.store.createTab({ url, active: true })
    } else if (manifest.options_page) {
      const url = `chrome-extension://${extension.id}/${manifest.options_page}`
      await this.ctx.store.createTab({ url, active: true })
    }
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/tabs.ts
```ts
import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesPattern, matchesTitlePattern, TabContents } from './common'
import { WindowsAPI } from './windows'

const debug = require('debug')('electron-chrome-extensions:tabs')

const validateExtensionUrl = (url: string, extension: Electron.Extension) => {
  // Convert relative URLs to absolute if needed
  try {
    url = new URL(url, extension.url).href
  } catch (e) {
    throw new Error('Invalid URL')
  }

  // Prevent creating chrome://kill or other debug commands
  if (url.startsWith('chrome:') || url.startsWith('javascript:')) {
    throw new Error('Invalid URL')
  }

  return url
}

export class TabsAPI {
  static TAB_ID_NONE = -1
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private observeTab(tab: TabContents) {
    const tabId = tab.id

    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible
      'did-start-navigation', // url
      'did-redirect-navigation', // url
      'did-navigate-in-page', // url
    ]

    const updateHandler = () => {
      this.onUpdated(tabId)
    }

    updateEvents.forEach((eventName) => {
      tab.on(eventName as any, updateHandler)
    })

    const faviconHandler = (event: Electron.Event, favicons: string[]) => {
      ;(tab as TabContents).favicon = favicons[0]
      this.onUpdated(tabId)
    }
    tab.on('page-favicon-updated', faviconHandler)

    tab.once('destroyed', () => {
      updateEvents.forEach((eventName) => {
        tab.off(eventName as any, updateHandler)
      })
      tab.off('page-favicon-updated', faviconHandler)

      this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })

    this.onCreated(tabId)
    this.onActivated(tabId)

    debug(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
  }

  private createTabDetails(tab: TabContents) {
    const tabId = tab.id
    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    let win = this.ctx.store.tabToWindow.get(tab)
    if (win?.isDestroyed()) win = undefined
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      height,
      highlighted: false,
      id: tabId,
      incognito: false,
      index: -1, // TODO
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      status: tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(), // TODO: tab.mainFrame.url (Electron 12)
      width,
      windowId: win ? win.id : -1,
    }

    if (typeof this.ctx.store.impl.assignTabDetails === 'function') {
      this.ctx.store.impl.assignTabDetails(details, tab)
    }

    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  private getTabDetails(tab: TabContents) {
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      return this.ctx.store.tabDetailsCache.get(tab.id)
    }
    const details = this.createTabDetails(tab)
    return details
  }

  private get(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return { id: TabsAPI.TAB_ID_NONE }
    return this.getTabDetails(tab)
  }

  private getAllInWindow(event: ExtensionEvent, windowId: number = TabsAPI.WINDOW_ID_CURRENT) {
    if (windowId === TabsAPI.WINDOW_ID_CURRENT) windowId = this.ctx.store.lastFocusedWindowId!

    const tabs = Array.from(this.ctx.store.tabs).filter((tab) => {
      if (tab.isDestroyed()) return false

      const browserWindow = this.ctx.store.tabToWindow.get(tab)
      if (!browserWindow || browserWindow.isDestroyed()) return

      return browserWindow.id === windowId
    })

    return tabs.map(this.getTabDetails.bind(this))
  }

  private getCurrent(event: ExtensionEvent) {
    const tab = this.ctx.store.getActiveTabOfCurrentWindow()
    return tab ? this.getTabDetails(tab) : undefined
  }

  private async create(event: ExtensionEvent, details: chrome.tabs.CreateProperties = {}) {
    const url = details.url ? validateExtensionUrl(details.url, event.extension) : undefined
    const tab = await this.ctx.store.createTab({ ...details, url })
    const tabDetails = this.getTabDetails(tab)
    if (details.active) {
      queueMicrotask(() => this.onActivated(tab.id))
    }
    return tabDetails
  }

  private insertCSS(event: ExtensionEvent, tabId: number, details: chrome.tabs.InjectDetails) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    // TODO: move to webFrame in renderer?
    if (details.code) {
      tab.insertCSS(details.code)
    }
  }

  private query(event: ExtensionEvent, info: chrome.tabs.QueryInfo = {}) {
    const isSet = (value: any) => typeof value !== 'undefined'

    const filteredTabs = Array.from(this.ctx.store.tabs)
      .map(this.getTabDetails.bind(this))
      .filter((tab) => {
        if (!tab) return false
        if (isSet(info.active) && info.active !== tab.active) return false
        if (isSet(info.pinned) && info.pinned !== tab.pinned) return false
        if (isSet(info.audible) && info.audible !== tab.audible) return false
        if (isSet(info.muted) && info.muted !== tab.mutedInfo?.muted) return false
        if (isSet(info.highlighted) && info.highlighted !== tab.highlighted) return false
        if (isSet(info.discarded) && info.discarded !== tab.discarded) return false
        if (isSet(info.autoDiscardable) && info.autoDiscardable !== tab.autoDiscardable)
          return false
        // if (isSet(info.currentWindow)) return false
        // if (isSet(info.lastFocusedWindow)) return false
        if (isSet(info.status) && info.status !== tab.status) return false
        if (isSet(info.title) && typeof info.title === 'string' && typeof tab.title === 'string') {
          if (!matchesTitlePattern(info.title, tab.title)) return false
        }
        if (isSet(info.url) && typeof tab.url === 'string') {
          if (typeof info.url === 'string' && !matchesPattern(info.url, tab.url!)) {
            return false
          } else if (
            Array.isArray(info.url) &&
            !info.url.some((pattern) => matchesPattern(pattern, tab.url!))
          ) {
            return false
          }
        }
        if (isSet(info.windowId)) {
          if (info.windowId === TabsAPI.WINDOW_ID_CURRENT) {
            if (this.ctx.store.lastFocusedWindowId !== tab.windowId) return false
          } else if (info.windowId !== tab.windowId) {
            return false
          }
        }
        // if (isSet(info.windowType) && info.windowType !== tab.windowType) return false
        // if (isSet(info.index) && info.index !== tab.index) return false
        return true
      })
      .map((tab, index) => {
        if (tab) {
          tab.index = index
        }
        return tab
      })
    return filteredTabs
  }

  private reload(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const tabId: number | undefined = typeof arg1 === 'number' ? arg1 : undefined
    const reloadProperties: chrome.tabs.ReloadProperties | null =
      typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    if (reloadProperties?.bypassCache) {
      tab.reloadIgnoringCache()
    } else {
      tab.reload()
    }
  }

  private async update(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    let tabId = typeof arg1 === 'number' ? arg1 : undefined
    const updateProperties: chrome.tabs.UpdateProperties =
      (typeof arg1 === 'object' ? (arg1 as any) : (arg2 as any)) || {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    tabId = tab.id

    const props = updateProperties

    const url = props.url ? validateExtensionUrl(props.url, event.extension) : undefined
    if (url) await tab.loadURL(url)

    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)

    if (props.active) this.onActivated(tabId)

    this.onUpdated(tabId)

    return this.createTabDetails(tab)
  }

  private remove(event: ExtensionEvent, id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id]

    ids.forEach((tabId) => {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab) this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })
  }

  private goForward(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.goForward()
  }

  private goBack(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.goBack()
  }

  onCreated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return
    const tabDetails = this.getTabDetails(tab)
    this.ctx.router.broadcastEvent('tabs.onCreated', tabDetails)
  }

  onUpdated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    let prevDetails
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      prevDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    }
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    const compareProps: (keyof chrome.tabs.Tab)[] = [
      'status',
      'url',
      'pinned',
      'audible',
      'discarded',
      'autoDiscardable',
      'mutedInfo',
      'favIconUrl',
      'title',
    ]

    let didUpdate = false
    const changeInfo: chrome.tabs.TabChangeInfo = {}

    for (const prop of compareProps) {
      if (details[prop] !== prevDetails[prop]) {
        ;(changeInfo as any)[prop] = details[prop]
        didUpdate = true
      }
    }

    if (!didUpdate) return

    this.ctx.router.broadcastEvent('tabs.onUpdated', tab.id, changeInfo, details)
  }

  onRemoved(tabId: number) {
    const details = this.ctx.store.tabDetailsCache.has(tabId)
      ? this.ctx.store.tabDetailsCache.get(tabId)
      : null
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = details ? details.windowId : WindowsAPI.WINDOW_ID_NONE
    const win =
      typeof windowId !== 'undefined' && windowId > -1
        ? BrowserWindow.getAllWindows().find((win) => win.id === windowId)
        : null

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false,
    })
  }

  onActivated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    const activeChanged = activeTab?.id !== tabId
    if (!activeChanged) return

    const win = this.ctx.store.tabToWindow.get(tab)

    this.ctx.store.setActiveTab(tab)

    // invalidate cache since 'active' has changed
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      tabInfo.active = tabId === cacheTabId
    })

    this.ctx.router.broadcastEvent('tabs.onActivated', {
      tabId,
      windowId: win?.id,
    })
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/web-navigation.ts
```ts
import * as electron from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const debug = require('debug')('electron-chrome-extensions:webNavigation')

// https://github.com/electron/electron/pull/25464
const getFrame = (frameProcessId: number, frameRoutingId: number) => {
  return (
    ('webFrameMain' in electron &&
      (electron as any).webFrameMain.fromId(frameProcessId, frameRoutingId)) ||
    null
  )
}

const getFrameId = (frame: any) =>
  'webFrameMain' in electron ? (frame === frame.top ? 0 : frame.frameTreeNodeId) : -1

const getParentFrameId = (frame: any) => {
  const parentFrame = frame?.parent
  return parentFrame ? getFrameId(parentFrame) : -1
}

const getFrameDetails = (frame: any) => ({
  errorOccurred: false, // TODO
  processId: frame.processId,
  frameId: getFrameId(frame),
  parentFrameId: getParentFrameId(frame),
  url: frame.url,
})

export class WebNavigationAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webNavigation.getFrame', this.getFrame.bind(this))
    handle('webNavigation.getAllFrames', this.getAllFrames.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private observeTab(tab: Electron.WebContents) {
    tab.once('will-navigate', this.onCreatedNavigationTarget.bind(this, tab))
    tab.on('did-start-navigation', this.onBeforeNavigate.bind(this, tab))
    tab.on('did-frame-finish-load', this.onFinishLoad.bind(this, tab))
    tab.on('did-frame-navigate', this.onCommitted.bind(this, tab))
    tab.on('did-navigate-in-page', this.onHistoryStateUpdated.bind(this, tab))

    tab.on('frame-created', (e, { frame }) => {
      if (frame.top === frame) return

      frame.on('dom-ready', () => {
        this.onDOMContentLoaded(tab, frame)
      })
    })

    // Main frame dom-ready event
    tab.on('dom-ready', () => {
      if ('mainFrame' in tab) {
        this.onDOMContentLoaded(tab, tab.mainFrame)
      }
    })
  }

  private getFrame(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails
  ): chrome.webNavigation.GetFrameResultDetails | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab) return null

    let targetFrame: any

    if (typeof details.frameId === 'number') {
      // https://github.com/electron/electron/pull/25464
      if ('mainFrame' in tab) {
        const mainFrame = (tab as any).mainFrame
        targetFrame = mainFrame.framesInSubtree.find((frame: any) => {
          const isMainFrame = frame === frame.top
          return isMainFrame ? details.frameId === 0 : details.frameId === frame.frameTreeNodeId
        })
      }
    }

    return targetFrame ? getFrameDetails(targetFrame) : null
  }

  private getAllFrames(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails
  ): chrome.webNavigation.GetAllFrameResultDetails[] | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab || !('mainFrame' in tab)) return []
    return (tab as any).mainFrame.framesInSubtree.map(getFrameDetails)
  }

  private sendNavigationEvent = (eventName: string, details: { url: string }) => {
    debug(`${eventName} [url: ${details.url}]`)
    this.ctx.router.broadcastEvent(`webNavigation.${eventName}`, details)
  }

  private onCreatedNavigationTarget = (
    tab: Electron.WebContents,
    event: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    ...args: any[]
  ) => {
    // Defaults for backwards compat prior to electron@25.0.0
    const { url = args[0] as string, frame = getFrame(args[3], args[4]) as Electron.WebFrameMain } =
      event

    const details: chrome.webNavigation.WebNavigationSourceCallbackDetails = {
      sourceTabId: tab.id,
      sourceProcessId: frame ? frame.processId : -1,
      sourceFrameId: getFrameId(frame),
      url,
      tabId: tab.id,
      timeStamp: Date.now(),
    }
    this.sendNavigationEvent('onCreatedNavigationTarget', details)
  }

  private onBeforeNavigate = (
    tab: Electron.WebContents,
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ...args: any[]
  ) => {
    // Defaults for backwards compat prior to electron@25.0.0
    const {
      url = args[0] as string,
      isSameDocument = args[1] as boolean,
      frame = getFrame(args[3], args[4]) as Electron.WebFrameMain,
    } = event

    if (isSameDocument) return

    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frame ? frame.processId : -1,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }

    this.sendNavigationEvent('onBeforeNavigate', details)
  }

  private onCommitted = (
    tab: Electron.WebContents,
    event: Electron.Event,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onCommitted', details)
  }

  private onHistoryStateUpdated = (
    tab: Electron.WebContents,
    event: Electron.Event,
    url: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    const details: chrome.webNavigation.WebNavigationTransitionCallbackDetails & {
      parentFrameId: number
    } = {
      transitionType: '', // TODO
      transitionQualifiers: [], // TODO
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onHistoryStateUpdated', details)
  }

  private onDOMContentLoaded = (tab: Electron.WebContents, frame: Electron.WebFrameMain) => {
    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frame.processId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url: frame.url,
    }
    this.sendNavigationEvent('onDOMContentLoaded', details)

    if (!tab.isLoadingMainFrame()) {
      this.sendNavigationEvent('onCompleted', details)
    }
  }

  private onFinishLoad = (
    tab: Electron.WebContents,
    event: Electron.Event,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    const url = tab.getURL()
    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onCompleted', details)
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/api/windows.ts
```ts
import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const debug = require('debug')('electron-chrome-extensions:windows')

const getWindowState = (win: BrowserWindow): chrome.windows.Window['state'] => {
  if (win.isMaximized()) return 'maximized'
  if (win.isMinimized()) return 'minimized'
  if (win.isFullScreen()) return 'fullscreen'
  return 'normal'
}

export class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('windows.get', this.get.bind(this))
    // TODO: how does getCurrent differ from getLastFocused?
    handle('windows.getCurrent', this.getLastFocused.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
  }

  private observeWindow(window: Electron.BrowserWindow) {
    const windowId = window.id

    window.on('focus', () => {
      this.onFocusChanged(windowId)
    })

    window.once('closed', () => {
      this.ctx.store.windowDetailsCache.delete(windowId)
      this.ctx.store.removeWindow(window)
      this.onRemoved(windowId)
    })

    this.onCreated(windowId)

    debug(`Observing window[${windowId}]`)
  }

  private createWindowDetails(win: BrowserWindow) {
    const details: Partial<chrome.windows.Window> = {
      id: win.id,
      focused: win.isFocused(),
      top: win.getPosition()[1],
      left: win.getPosition()[0],
      width: win.getSize()[0],
      height: win.getSize()[1],
      tabs: Array.from(this.ctx.store.tabs)
        .filter((tab) => {
          const ownerWindow = this.ctx.store.tabToWindow.get(tab)
          return ownerWindow?.isDestroyed() ? false : ownerWindow?.id === win.id
        })
        .map((tab) => this.ctx.store.tabDetailsCache.get(tab.id) as chrome.tabs.Tab)
        .filter(Boolean),
      incognito: !win.webContents.session.isPersistent(),
      type: 'normal', // TODO
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
      sessionId: 'default', // TODO
    }

    this.ctx.store.windowDetailsCache.set(win.id, details)
    return details
  }

  private getWindowDetails(win: BrowserWindow) {
    if (this.ctx.store.windowDetailsCache.has(win.id)) {
      return this.ctx.store.windowDetailsCache.get(win.id)
    }
    const details = this.createWindowDetails(win)
    return details
  }

  private getWindowFromId(id: number) {
    if (id === WindowsAPI.WINDOW_ID_CURRENT) {
      return this.ctx.store.getCurrentWindow()
    } else {
      return this.ctx.store.getWindowById(id)
    }
  }

  private get(event: ExtensionEvent, windowId: number) {
    const win = this.getWindowFromId(windowId)
    if (!win) return { id: WindowsAPI.WINDOW_ID_NONE }
    return this.getWindowDetails(win)
  }

  private getLastFocused(event: ExtensionEvent) {
    const win = this.ctx.store.getLastFocusedWindow()
    return win ? this.getWindowDetails(win) : null
  }

  private getAll(event: ExtensionEvent) {
    return Array.from(this.ctx.store.windows).map(this.getWindowDetails.bind(this))
  }

  private async create(event: ExtensionEvent, details: chrome.windows.CreateData) {
    const win = await this.ctx.store.createWindow(event, details)
    return this.getWindowDetails(win)
  }

  private async update(
    event: ExtensionEvent,
    windowId: number,
    updateProperties: chrome.windows.UpdateInfo = {}
  ) {
    const win = this.getWindowFromId(windowId)
    if (!win) return

    const props = updateProperties

    if (props.state) {
      switch (props.state) {
        case 'maximized':
          win.maximize()
          break
        case 'minimized':
          win.minimize()
          break
        case 'normal': {
          if (win.isMinimized() || win.isMaximized()) {
            win.restore()
          }
          break
        }
      }
    }

    return this.createWindowDetails(win)
  }

  private async remove(event: ExtensionEvent, windowId: number = WindowsAPI.WINDOW_ID_CURRENT) {
    const win = this.getWindowFromId(windowId)
    if (!win) return
    const removedWindowId = win.id
    await this.ctx.store.removeWindow(win)
    this.onRemoved(removedWindowId)
  }

  onCreated(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const windowDetails = this.getWindowDetails(window)
    this.ctx.router.broadcastEvent('windows.onCreated', windowDetails)
  }

  onRemoved(windowId: number) {
    this.ctx.router.broadcastEvent('windows.onRemoved', windowId)
  }

  onFocusChanged(windowId: number) {
    if (this.ctx.store.lastFocusedWindowId === windowId) return

    this.ctx.store.lastFocusedWindowId = windowId
    this.ctx.router.broadcastEvent('windows.onFocusChanged', windowId)
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/context.ts
```ts
import { EventEmitter } from 'events'
import { ExtensionRouter } from './router'
import { ExtensionStore } from './store'

/** Shared context for extensions in a session. */
export interface ExtensionContext {
  emit: typeof EventEmitter['prototype']['emit']
  router: ExtensionRouter
  session: Electron.Session
  store: ExtensionStore
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/impl.ts
```ts
/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties
  ): Promise<[Electron.WebContents, Electron.BrowserWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BrowserWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BrowserWindow): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BrowserWindow>
  removeWindow?(window: Electron.BrowserWindow): void
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/index.ts
```ts
import { app, session as electronSession } from 'electron'
import { EventEmitter } from 'events'
import path from 'path'
import { promises as fs } from 'fs'

import { BrowserActionAPI } from './api/browser-action'
import { TabsAPI } from './api/tabs'
import { WindowsAPI } from './api/windows'
import { WebNavigationAPI } from './api/web-navigation'
import { ExtensionStore } from './store'
import { ContextMenusAPI } from './api/context-menus'
import { RuntimeAPI } from './api/runtime'
import { CookiesAPI } from './api/cookies'
import { NotificationsAPI } from './api/notifications'
import { ChromeExtensionImpl } from './impl'
import { CommandsAPI } from './api/commands'
import { ExtensionContext } from './context'
import { ExtensionRouter } from './router'

export interface ChromeExtensionOptions extends ChromeExtensionImpl {
  session?: Electron.Session

  /**
   * Path to electron-chrome-extensions module files. Might be needed if
   * JavaScript bundlers like Webpack are used in your build process.
   */
  modulePath?: string
}

const sessionMap = new WeakMap<Electron.Session, ElectronChromeExtensions>()

/**
 * Provides an implementation of various Chrome extension APIs to a session.
 */
export class ElectronChromeExtensions extends EventEmitter {
  /** Retrieve an instance of this class associated with the given session. */
  static fromSession(session: Electron.Session) {
    return sessionMap.get(session)
  }

  private ctx: ExtensionContext
  private modulePath: string

  private api: {
    browserAction: BrowserActionAPI
    contextMenus: ContextMenusAPI
    commands: CommandsAPI
    cookies: CookiesAPI
    notifications: NotificationsAPI
    runtime: RuntimeAPI
    tabs: TabsAPI
    webNavigation: WebNavigationAPI
    windows: WindowsAPI
  }

  constructor(opts?: ChromeExtensionOptions) {
    super()

    const { session = electronSession.defaultSession, modulePath, ...impl } = opts || {}

    if (sessionMap.has(session)) {
      throw new Error(`Extensions instance already exists for the given session`)
    }

    sessionMap.set(session, this)

    const router = new ExtensionRouter(session)
    const store = new ExtensionStore(impl)

    this.ctx = {
      emit: this.emit.bind(this),
      router,
      session,
      store,
    }

    this.modulePath = modulePath || path.join(__dirname, '..')

    this.api = {
      browserAction: new BrowserActionAPI(this.ctx),
      contextMenus: new ContextMenusAPI(this.ctx),
      commands: new CommandsAPI(this.ctx),
      cookies: new CookiesAPI(this.ctx),
      notifications: new NotificationsAPI(this.ctx),
      runtime: new RuntimeAPI(this.ctx),
      tabs: new TabsAPI(this.ctx),
      webNavigation: new WebNavigationAPI(this.ctx),
      windows: new WindowsAPI(this.ctx),
    }

    this.prependPreload()
  }

  private async prependPreload() {
    const { session } = this.ctx
    let preloads = session.getPreloads()

    const preloadPath = path.join(this.modulePath, 'dist/preload.js')

    const preloadIndex = preloads.indexOf(preloadPath)
    if (preloadIndex > -1) {
      preloads.splice(preloadIndex, 1)
    }

    preloads = [preloadPath, ...preloads]
    session.setPreloads(preloads)

    let preloadExists = false
    try {
      const stat = await fs.stat(preloadPath)
      preloadExists = stat.isFile()
    } catch {}

    if (!preloadExists) {
      console.error(
        `Unable to access electron-chrome-extensions preload file (${preloadPath}). Consider configuring the 'modulePath' constructor option.`
      )
    }
  }

  /** Add webContents to be tracked as a tab. */
  addTab(tab: Electron.WebContents, window: Electron.BrowserWindow) {
    this.ctx.store.addTab(tab, window)
  }

  /** Notify extension system that the active tab has changed. */
  selectTab(tab: Electron.WebContents) {
    if (this.ctx.store.tabs.has(tab)) {
      this.api.tabs.onActivated(tab.id)
    }
  }

  /**
   * Add webContents to be tracked as an extension host which will receive
   * extension events when a chrome-extension:// resource is loaded.
   *
   * This is usually reserved for extension background pages and popups, but
   * can also be used in other special cases.
   *
   * @deprecated Extension hosts are now tracked lazily when they send
   * extension IPCs to the main process.
   */
  addExtensionHost(host: Electron.WebContents) {
    console.warn('ElectronChromeExtensions.addExtensionHost() is deprecated')
  }

  /**
   * Get collection of menu items managed by the `chrome.contextMenus` API.
   * @see https://developer.chrome.com/extensions/contextMenus
   */
  getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams) {
    return this.api.contextMenus.buildMenuItemsForParams(webContents, params)
  }

  /**
   * Add extensions to be visible as an extension action button.
   *
   * @deprecated Not needed in Electron >=12.
   */
  addExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.addExtension() is deprecated')
    this.api.browserAction.processExtension(extension)
  }

  /**
   * Remove extensions from the list of visible extension action buttons.
   *
   * @deprecated Not needed in Electron >=12.
   */
  removeExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.removeExtension() is deprecated')
    this.api.browserAction.removeActions(extension.id)
  }
}

/**
 * @deprecated Use `ElectronChromeExtensions` instead.
 */
export const Extensions = ElectronChromeExtensions

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/popup.ts
```ts
import { BrowserWindow, Session } from 'electron'

const debug = require('debug')('electron-chrome-extensions:popup')

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

interface PopupViewOptions {
  extensionId: string
  session: Session
  parent: BrowserWindow
  url: string
  anchorRect: PopupAnchorRect
}

const supportsPreferredSize = () => {
  const major = parseInt(process.versions.electron.split('.').shift() || '', 10)
  return major >= 12
}

export class PopupView {
  static POSITION_PADDING = 5

  static BOUNDS = {
    minWidth: 25,
    minHeight: 25,
    maxWidth: 800,
    maxHeight: 600,
  }

  browserWindow?: BrowserWindow
  parent?: BrowserWindow
  extensionId: string

  private anchorRect: PopupAnchorRect
  private destroyed: boolean = false
  private hidden: boolean = true

  /** Preferred size changes are only received in Electron v12+ */
  private usingPreferredSize = supportsPreferredSize()

  private readyPromise: Promise<void>

  constructor(opts: PopupViewOptions) {
    this.parent = opts.parent
    this.extensionId = opts.extensionId
    this.anchorRect = opts.anchorRect

    this.browserWindow = new BrowserWindow({
      show: false,
      frame: false,
      parent: opts.parent,
      movable: false,
      maximizable: false,
      minimizable: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: opts.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enablePreferredSizeMode: true,
      },
    })

    const untypedWebContents = this.browserWindow.webContents as any
    untypedWebContents.on('preferred-size-changed', this.updatePreferredSize)

    this.browserWindow.webContents.on('devtools-closed', this.maybeClose)
    this.browserWindow.on('blur', this.maybeClose)
    this.browserWindow.on('closed', this.destroy)
    this.parent.once('closed', this.destroy)

    this.readyPromise = this.load(opts.url)
  }

  private show() {
    this.hidden = false
    this.browserWindow?.show()
  }

  private async load(url: string): Promise<void> {
    const win = this.browserWindow!

    try {
      await win.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }

    if (this.destroyed) return

    if (this.usingPreferredSize) {
      // Set small initial size so the preferred size grows to what's needed
      this.setSize({ width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight })
    } else {
      // Set large initial size to avoid overflow
      this.setSize({ width: PopupView.BOUNDS.maxWidth, height: PopupView.BOUNDS.maxHeight })

      // Wait for content and layout to load
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (this.destroyed) return

      await this.queryPreferredSize()
      if (this.destroyed) return

      this.show()
    }
  }

  destroy = () => {
    if (this.destroyed) return

    this.destroyed = true

    debug(`destroying ${this.extensionId}`)

    if (this.parent) {
      if (!this.parent.isDestroyed()) {
        this.parent.off('closed', this.destroy)
      }
      this.parent = undefined
    }

    if (this.browserWindow) {
      if (!this.browserWindow.isDestroyed()) {
        const { webContents } = this.browserWindow

        if (!webContents.isDestroyed() && webContents.isDevToolsOpened()) {
          webContents.closeDevTools()
        }

        this.browserWindow.off('closed', this.destroy)
        this.browserWindow.destroy()
      }

      this.browserWindow = undefined
    }
  }

  isDestroyed() {
    return this.destroyed
  }

  /** Resolves when the popup finishes loading. */
  whenReady() {
    return this.readyPromise
  }

  setSize(rect: Partial<Electron.Rectangle>) {
    if (!this.browserWindow || !this.parent) return

    const width = Math.floor(
      Math.min(PopupView.BOUNDS.maxWidth, Math.max(rect.width || 0, PopupView.BOUNDS.minWidth))
    )

    const height = Math.floor(
      Math.min(PopupView.BOUNDS.maxHeight, Math.max(rect.height || 0, PopupView.BOUNDS.minHeight))
    )

    debug(`setSize`, { width, height })

    this.browserWindow?.setBounds({
      ...this.browserWindow.getBounds(),
      width,
      height,
    })
  }

  private maybeClose = () => {
    // Keep open if webContents is being inspected
    if (!this.browserWindow?.isDestroyed() && this.browserWindow?.webContents.isDevToolsOpened()) {
      debug('preventing close due to DevTools being open')
      return
    }

    // For extension popups with a login form, the user may need to access a
    // program outside of the app. Closing the popup would then add
    // inconvenience.
    if (!BrowserWindow.getFocusedWindow()) {
      debug('preventing close due to focus residing outside of the app')
      return
    }

    this.destroy()
  }

  private updatePosition() {
    if (!this.browserWindow || !this.parent) return

    const winBounds = this.parent.getBounds()
    const viewBounds = this.browserWindow.getBounds()

    // TODO: support more orientations than just top-right
    let x = winBounds.x + this.anchorRect.x + this.anchorRect.width - viewBounds.width
    let y = winBounds.y + this.anchorRect.y + this.anchorRect.height + PopupView.POSITION_PADDING

    // Convert to ints
    x = Math.floor(x)
    y = Math.floor(y)

    debug(`updatePosition`, { x, y })

    this.browserWindow.setBounds({
      ...this.browserWindow.getBounds(),
      x,
      y,
    })
  }

  /** Backwards compat for Electron <12 */
  private async queryPreferredSize() {
    if (this.usingPreferredSize || this.destroyed) return

    const rect = await this.browserWindow!.webContents.executeJavaScript(
      `((${() => {
        const rect = document.body.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }})())`
    )

    if (this.destroyed) return

    this.setSize({ width: rect.width, height: rect.height })
    this.updatePosition()
  }

  private updatePreferredSize = (event: Electron.Event, size: Electron.Size) => {
    debug('updatePreferredSize', size)
    this.usingPreferredSize = true
    this.setSize(size)
    this.updatePosition()

    // Wait to reveal popup until it's sized and positioned correctly
    if (this.hidden) this.show()
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/router.ts
```ts
import { app, Extension, ipcMain, session, Session, WebContents } from 'electron'

const createDebug = require('debug')

// Shorten base64 encoded icons
const shortenValues = (k: string, v: any) =>
  typeof v === 'string' && v.length > 128 ? v.substr(0, 128) + '...' : v

createDebug.formatters.r = (value: any) => {
  return value ? JSON.stringify(value, shortenValues, '  ') : value
}

const debug = createDebug('electron-chrome-extensions:router')

const DEFAULT_SESSION = '_self'

interface RoutingDelegateObserver {
  session: Electron.Session
  onExtensionMessage(
    event: Electron.IpcMainInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ): Promise<void>
  addListener(listener: EventListener, extensionId: string, eventName: string): void
  removeListener(listener: EventListener, extensionId: string, eventName: string): void
}

let gRoutingDelegate: RoutingDelegate

/**
 * Handles event routing IPCs and delivers them to the observer with the
 * associated session.
 */
class RoutingDelegate {
  static get() {
    return gRoutingDelegate || (gRoutingDelegate = new RoutingDelegate())
  }

  private sessionMap: WeakMap<Session, RoutingDelegateObserver> = new WeakMap()

  private constructor() {
    ipcMain.handle('crx-msg', this.onRouterMessage)
    ipcMain.handle('crx-msg-remote', this.onRemoteMessage)
    ipcMain.on('crx-add-listener', this.onAddListener)
    ipcMain.on('crx-remove-listener', this.onRemoveListener)
  }

  addObserver(observer: RoutingDelegateObserver) {
    this.sessionMap.set(observer.session, observer)
  }

  private onRouterMessage = async (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    handlerName: string,
    ...args: any[]
  ) => {
    debug(`received '${handlerName}'`, args)

    const observer = this.sessionMap.get(event.sender.session)

    return observer?.onExtensionMessage(event, extensionId, handlerName, ...args)
  }

  private onRemoteMessage = async (
    event: Electron.IpcMainInvokeEvent,
    sessionPartition: string,
    handlerName: string,
    ...args: any[]
  ) => {
    debug(`received remote '${handlerName}' for '${sessionPartition}'`, args)

    const ses =
      sessionPartition === DEFAULT_SESSION
        ? event.sender.session
        : session.fromPartition(sessionPartition)

    const observer = this.sessionMap.get(ses)

    return observer?.onExtensionMessage(event, undefined, handlerName, ...args)
  }

  private onAddListener = (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    eventName: string
  ) => {
    const observer = this.sessionMap.get(event.sender.session)
    const listener: EventListener = { host: event.sender, extensionId }
    return observer?.addListener(listener, extensionId, eventName)
  }

  private onRemoveListener = (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    eventName: string
  ) => {
    const observer = this.sessionMap.get(event.sender.session)
    const listener: EventListener = { host: event.sender, extensionId }
    return observer?.removeListener(listener, extensionId, eventName)
  }
}

export interface ExtensionEvent {
  sender: WebContents
  extension: Extension
}

export type HandlerCallback = (event: ExtensionEvent, ...args: any[]) => any

export interface HandlerOptions {
  /** Whether the handler can be invoked on behalf of a different session. */
  allowRemote?: boolean
  /** Whether an extension context is required to invoke the handler. */
  extensionContext: boolean
}

interface Handler extends HandlerOptions {
  callback: HandlerCallback
}

/** e.g. 'tabs.query' */
type EventName = string

type HandlerMap = Map<EventName, Handler>

interface EventListener {
  host: Electron.WebContents
  extensionId: string
}

const eventListenerEquals = (eventListener: EventListener) => (other: EventListener) =>
  other.host === eventListener.host && other.extensionId === eventListener.extensionId

export class ExtensionRouter {
  private handlers: HandlerMap = new Map()
  private listeners: Map<EventName, EventListener[]> = new Map()

  /**
   * Collection of all extension hosts in the session.
   *
   * Currently the router has no ability to wake up non-persistent background
   * scripts to deliver events. For now we just hold a reference to them to
   * prevent them from being terminated.
   */
  private extensionHosts: Set<Electron.WebContents> = new Set()

  constructor(
    public session: Electron.Session,
    private delegate: RoutingDelegate = RoutingDelegate.get()
  ) {
    this.delegate.addObserver(this)

    session.on('extension-unloaded', (event, extension) => {
      this.filterListeners((listener) => listener.extensionId !== extension.id)
    })

    app.on('web-contents-created', (event, webContents) => {
      if (webContents.session === this.session && webContents.getType() === 'backgroundPage') {
        debug(`storing reference to background host [url:'${webContents.getURL()}']`)
        this.extensionHosts.add(webContents)
      }
    })
  }

  private filterListeners(predicate: (listener: EventListener) => boolean) {
    for (const [eventName, listeners] of this.listeners) {
      const filteredListeners = listeners.filter(predicate)
      const delta = listeners.length - filteredListeners.length

      if (filteredListeners.length > 0) {
        this.listeners.set(eventName, filteredListeners)
      } else {
        this.listeners.delete(eventName)
      }

      if (delta > 0) {
        debug(`removed ${delta} listener(s) for '${eventName}'`)
      }
    }
  }

  private observeListenerHost(host: Electron.WebContents) {
    debug(`observing listener [id:${host.id}, url:'${host.getURL()}']`)
    host.once('destroyed', () => {
      debug(`extension host destroyed [id:${host.id}]`)
      this.filterListeners((listener) => listener.host !== host)
    })
  }

  addListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners, session } = this

    const extension = session.getExtension(extensionId)
    if (!extension) {
      throw new Error(`extension not registered in session [extensionId:${extensionId}]`)
    }

    if (!listeners.has(eventName)) {
      listeners.set(eventName, [])
    }

    const eventListeners = listeners.get(eventName)!
    const existingEventListener = eventListeners.find(eventListenerEquals(listener))

    if (existingEventListener) {
      debug(`ignoring existing '${eventName}' event listener for ${extensionId}`)
    } else {
      debug(`adding '${eventName}' event listener for ${extensionId}`)
      eventListeners.push(listener)
      this.observeListenerHost(listener.host)
    }
  }

  removeListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners } = this

    const eventListeners = listeners.get(eventName)
    if (!eventListeners) {
      console.error(`event listener not registered for '${eventName}'`)
      return
    }

    const index = eventListeners.findIndex(eventListenerEquals(listener))

    if (index >= 0) {
      debug(`removing '${eventName}' event listener for ${extensionId}`)
      eventListeners.splice(index, 1)
    }

    if (eventListeners.length === 0) {
      listeners.delete(eventName)
    }
  }

  private getHandler(handlerName: string) {
    const handler = this.handlers.get(handlerName)
    if (!handler) {
      throw new Error(`${handlerName} is not a registered handler`)
    }

    return handler
  }

  async onExtensionMessage(
    event: Electron.IpcMainInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ) {
    const { session } = this
    const { sender } = event
    const handler = this.getHandler(handlerName)

    if (sender.session !== session && !handler.allowRemote) {
      throw new Error(`${handlerName} does not support calling from a remote session`)
    }

    const extension = extensionId ? sender.session.getExtension(extensionId) : undefined
    if (!extension && handler.extensionContext) {
      throw new Error(`${handlerName} was sent from an unknown extension context`)
    }

    const extEvent = {
      sender,
      extension: extension!,
    }

    const result = await handler.callback(extEvent, ...args)

    debug(`${handlerName} result: %r`, result)

    return result
  }

  private handle(name: string, callback: HandlerCallback, opts?: HandlerOptions): void {
    this.handlers.set(name, {
      callback,
      extensionContext: typeof opts?.extensionContext === 'boolean' ? opts.extensionContext : true,
      allowRemote: typeof opts?.allowRemote === 'boolean' ? opts.allowRemote : false,
    })
  }

  /** Returns a callback to register API handlers for the given context. */
  apiHandler() {
    return (name: string, callback: HandlerCallback, opts?: HandlerOptions) => {
      this.handle(name, callback, opts)
    }
  }

  /**
   * Sends extension event to the host for the given extension ID if it
   * registered a listener for it.
   */
  sendEvent(extensionId: string | undefined, eventName: string, ...args: any[]) {
    const { listeners } = this

    let eventListeners = listeners.get(eventName)

    if (extensionId) {
      // TODO: extension permissions check

      eventListeners = eventListeners?.filter((el) => el.extensionId === extensionId)
    }

    if (!eventListeners || eventListeners.length === 0) {
      debug(`ignoring '${eventName}' event with no listeners`)
      return
    }

    for (const { host } of eventListeners) {
      // TODO: may need to wake lazy extension context
      if (host.isDestroyed()) {
        console.error(`Unable to send '${eventName}' to extension host for ${extensionId}`)
        continue
      }

      const ipcName = `crx-${eventName}`
      host.send(ipcName, ...args)
    }
  }

  /** Broadcasts extension event to all extension hosts listening for it. */
  broadcastEvent(eventName: string, ...args: any[]) {
    this.sendEvent(undefined, eventName, ...args)
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser/store.ts
```ts
import { BrowserWindow, webContents } from 'electron'
import { EventEmitter } from 'events'
import { ContextMenuType } from './api/common'
import { ChromeExtensionImpl } from './impl'
import { ExtensionEvent } from './router'

const debug = require('debug')('electron-chrome-extensions:store')

export class ExtensionStore extends EventEmitter {
  /** Tabs observed by the extensions system. */
  tabs = new Set<Electron.WebContents>()

  /** Windows observed by the extensions system. */
  windows = new Set<Electron.BrowserWindow>()

  lastFocusedWindowId?: number

  /**
   * Map of tabs to their parent window.
   *
   * It's not possible to access the parent of a BrowserView so we must manage
   * this ourselves.
   */
  tabToWindow = new WeakMap<Electron.WebContents, Electron.BrowserWindow>()

  /** Map of windows to their active tab. */
  private windowToActiveTab = new WeakMap<Electron.BrowserWindow, Electron.WebContents>()

  tabDetailsCache = new Map<number, Partial<chrome.tabs.Tab>>()
  windowDetailsCache = new Map<number, Partial<chrome.windows.Window>>()

  constructor(public impl: ChromeExtensionImpl) {
    super()
  }

  getWindowById(windowId: number) {
    return Array.from(this.windows).find(
      (window) => !window.isDestroyed() && window.id === windowId
    )
  }

  getLastFocusedWindow() {
    return this.lastFocusedWindowId ? this.getWindowById(this.lastFocusedWindowId) : null
  }

  getCurrentWindow() {
    return this.getLastFocusedWindow()
  }

  addWindow(window: Electron.BrowserWindow) {
    if (this.windows.has(window)) return

    this.windows.add(window)

    if (typeof this.lastFocusedWindowId !== 'number') {
      this.lastFocusedWindowId = window.id
    }

    this.emit('window-added', window)
  }

  async createWindow(event: ExtensionEvent, details: chrome.windows.CreateData) {
    if (typeof this.impl.createWindow !== 'function') {
      throw new Error('createWindow is not implemented')
    }

    const win = await this.impl.createWindow(details)

    this.addWindow(win)

    return win
  }

  async removeWindow(window: Electron.BrowserWindow) {
    if (!this.windows.has(window)) return

    this.windows.delete(window)

    if (typeof this.impl.removeWindow === 'function') {
      await this.impl.removeWindow(window)
    } else {
      window.destroy()
    }
  }

  getTabById(tabId: number) {
    return Array.from(this.tabs).find((tab) => !tab.isDestroyed() && tab.id === tabId)
  }

  addTab(tab: Electron.WebContents, window: Electron.BrowserWindow) {
    if (this.tabs.has(tab)) return

    this.tabs.add(tab)
    this.tabToWindow.set(tab, window)
    this.addWindow(window)

    const activeTab = this.getActiveTabFromWebContents(tab)
    if (!activeTab) {
      this.setActiveTab(tab)
    }

    this.emit('tab-added', tab)
  }

  removeTab(tab: Electron.WebContents) {
    if (!this.tabs.has(tab)) return

    const tabId = tab.id
    const win = this.tabToWindow.get(tab)!

    this.tabs.delete(tab)
    this.tabToWindow.delete(tab)

    // TODO: clear active tab

    // Clear window if it has no remaining tabs
    const windowHasTabs = Array.from(this.tabs).find((tab) => this.tabToWindow.get(tab) === win)
    if (!windowHasTabs) {
      this.windows.delete(win)
    }

    if (typeof this.impl.removeTab === 'function') {
      this.impl.removeTab(tab, win)
    }

    this.emit('tab-removed', tabId)
  }

  async createTab(details: chrome.tabs.CreateProperties) {
    if (typeof this.impl.createTab !== 'function') {
      throw new Error('createTab is not implemented')
    }

    // Fallback to current window
    if (!details.windowId) {
      details.windowId = this.lastFocusedWindowId
    }

    const result = await this.impl.createTab(details)

    if (!Array.isArray(result)) {
      throw new Error('createTab must return an array of [tab, window]')
    }

    const [tab, window] = result

    if (typeof tab !== 'object' || !webContents.fromId(tab.id)) {
      throw new Error('createTab must return a WebContents')
    } else if (typeof window !== 'object') {
      throw new Error('createTab must return a BrowserWindow')
    }

    this.addTab(tab, window)

    return tab
  }

  getActiveTabFromWindow(win: Electron.BrowserWindow) {
    const activeTab = win && !win.isDestroyed() && this.windowToActiveTab.get(win)
    return (activeTab && !activeTab.isDestroyed() && activeTab) || undefined
  }

  getActiveTabFromWebContents(wc: Electron.WebContents): Electron.WebContents | undefined {
    const win = this.tabToWindow.get(wc) || BrowserWindow.fromWebContents(wc)
    const activeTab = win ? this.getActiveTabFromWindow(win) : undefined
    return activeTab
  }

  getActiveTabOfCurrentWindow() {
    const win = this.getCurrentWindow()
    return win ? this.getActiveTabFromWindow(win) : undefined
  }

  setActiveTab(tab: Electron.WebContents) {
    const win = this.tabToWindow.get(tab)
    if (!win) {
      throw new Error('Active tab has no parent window')
    }

    const prevActiveTab = this.getActiveTabFromWebContents(tab)

    this.windowToActiveTab.set(win, tab)

    if (tab.id !== prevActiveTab?.id) {
      this.emit('active-tab-changed', tab, win)

      if (typeof this.impl.selectTab === 'function') {
        this.impl.selectTab(tab, win)
      }
    }
  }

  buildMenuItems(extensionId: string, menuType: ContextMenuType): Electron.MenuItem[] {
    // This function is overwritten by ContextMenusAPI
    return []
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/browser-action.ts
```ts
import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { EventEmitter } from 'events'

export const injectBrowserAction = () => {
  const actionMap = new Map<string, any>()
  const internalEmitter = new EventEmitter()
  const observerCounts = new Map<string, number>()

  const invoke = <T>(name: string, partition: string, ...args: any[]): Promise<T> => {
    return ipcRenderer.invoke('crx-msg-remote', partition, name, ...args)
  }

  interface ActivateDetails {
    eventType: string
    extensionId: string
    tabId: number
    anchorRect: { x: number; y: number; width: number; height: number }
  }

  const browserAction = {
    addEventListener(name: string, listener: (...args: any[]) => void) {
      internalEmitter.addListener(name, listener)
    },
    removeEventListener(name: string, listener: (...args: any[]) => void) {
      internalEmitter.removeListener(name, listener)
    },

    getAction(extensionId: string) {
      return actionMap.get(extensionId)
    },
    async getState(partition: string): Promise<{ activeTabId?: number; actions: any[] }> {
      const state = await invoke<any>('browserAction.getState', partition)
      for (const action of state.actions) {
        actionMap.set(action.id, action)
      }
      queueMicrotask(() => internalEmitter.emit('update', state))
      return state
    },

    activate: (partition: string, details: ActivateDetails) => {
      return invoke('browserAction.activate', partition, details)
    },

    addObserver(partition: string) {
      let count = observerCounts.has(partition) ? observerCounts.get(partition)! : 0
      count = count + 1
      observerCounts.set(partition, count)

      if (count === 1) {
        invoke('browserAction.addObserver', partition)
      }
    },
    removeObserver(partition: string) {
      let count = observerCounts.has(partition) ? observerCounts.get(partition)! : 0
      count = Math.max(count - 1, 0)
      observerCounts.set(partition, count)

      if (count === 0) {
        invoke('browserAction.removeObserver', partition)
      }
    },
  }

  ipcRenderer.on('browserAction.update', () => {
    for (const partition of observerCounts.keys()) {
      browserAction.getState(partition)
    }
  })

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variables can be used!
  function mainWorldScript() {
    const DEFAULT_PARTITION = '_self'

    class BrowserActionElement extends HTMLButtonElement {
      private updateId?: number
      private badge?: HTMLDivElement
      private pendingIcon?: HTMLImageElement

      get id(): string {
        return this.getAttribute('id') || ''
      }

      set id(id: string) {
        this.setAttribute('id', id)
      }

      get tab(): number {
        const tabId = parseInt(this.getAttribute('tab') || '', 10)
        return typeof tabId === 'number' && !isNaN(tabId) ? tabId : -1
      }

      set tab(tab: number) {
        this.setAttribute('tab', `${tab}`)
      }

      get partition(): string | null {
        return this.getAttribute('partition')
      }

      set partition(partition: string | null) {
        if (partition) {
          this.setAttribute('partition', partition)
        } else {
          this.removeAttribute('partition')
        }
      }

      static get observedAttributes() {
        return ['id', 'tab', 'partition']
      }

      constructor() {
        super()

        // TODO: event delegation
        this.addEventListener('click', this.onClick.bind(this))
        this.addEventListener('contextmenu', this.onContextMenu.bind(this))
      }

      connectedCallback() {
        if (this.isConnected) {
          this.update()
        }
      }

      disconnectedCallback() {
        if (this.updateId) {
          cancelAnimationFrame(this.updateId)
          this.updateId = undefined
        }
        if (this.pendingIcon) {
          this.pendingIcon = undefined
        }
      }

      attributeChangedCallback() {
        if (this.isConnected) {
          this.update()
        }
      }

      private activate(event: Event) {
        const rect = this.getBoundingClientRect()

        browserAction.activate(this.partition || DEFAULT_PARTITION, {
          eventType: event.type,
          extensionId: this.id,
          tabId: this.tab,
          anchorRect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        })
      }

      private onClick(event: MouseEvent) {
        this.activate(event)
      }

      private onContextMenu(event: MouseEvent) {
        event.stopImmediatePropagation()
        event.preventDefault()

        this.activate(event)
      }

      private getBadge() {
        let badge = this.badge
        if (!badge) {
          this.badge = badge = document.createElement('div')
          badge.className = 'badge'
          ;(badge as any).part = 'badge'
          this.appendChild(badge)
        }
        return badge
      }

      private update() {
        if (this.updateId) return
        this.updateId = requestAnimationFrame(this.updateCallback.bind(this))
      }

      private updateIcon(info: any) {
        const iconSize = 32
        const resizeType = 2
        const timeParam = info.iconModified ? `&t=${info.iconModified}` : ''
        const iconUrl = `crx://extension-icon/${this.id}/${iconSize}/${resizeType}?tabId=${this.tab}${timeParam}`
        const bgImage = `url(${iconUrl})`

        if (this.pendingIcon) {
          this.pendingIcon = undefined
        }

        // Preload icon to prevent it from blinking
        const img = (this.pendingIcon = new Image())
        img.onload = () => {
          if (this.isConnected) {
            this.style.backgroundImage = bgImage
            this.pendingIcon = undefined
          }
        }
        img.src = iconUrl
      }

      private updateCallback() {
        this.updateId = undefined

        const action = browserAction.getAction(this.id)

        const activeTabId = this.tab
        const tabInfo = activeTabId > -1 ? action.tabs[activeTabId] : {}
        const info = { ...tabInfo, ...action }

        this.title = typeof info.title === 'string' ? info.title : ''

        this.updateIcon(info)

        if (info.text) {
          const badge = this.getBadge()
          badge.textContent = info.text
          badge.style.color = '#fff' // TODO: determine bg lightness?
          badge.style.backgroundColor = info.color
        } else if (this.badge) {
          this.badge.remove()
          this.badge = undefined
        }
      }
    }

    customElements.define('browser-action', BrowserActionElement, { extends: 'button' })

    class BrowserActionListElement extends HTMLElement {
      private observing: boolean = false

      get tab(): number | null {
        const tabId = parseInt(this.getAttribute('tab') || '', 10)
        return typeof tabId === 'number' && !isNaN(tabId) ? tabId : null
      }

      set tab(tab: number | null) {
        if (typeof tab === 'number') {
          this.setAttribute('tab', `${tab}`)
        } else {
          this.removeAttribute('tab')
        }
      }

      get partition(): string | null {
        return this.getAttribute('partition')
      }

      set partition(partition: string | null) {
        if (partition) {
          this.setAttribute('partition', partition)
        } else {
          this.removeAttribute('partition')
        }
      }

      static get observedAttributes() {
        return ['tab', 'partition']
      }

      constructor() {
        super()

        const shadowRoot = this.attachShadow({ mode: 'open' })

        const style = document.createElement('style')
        style.textContent = `
:host {
  display: flex;
  flex-direction: row;
  gap: 5px;
}

.action {
  width: 28px;
  height: 28px;
  background-color: transparent;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 70%;
  border: none;
  border-radius: 4px;
  padding: 0;
  position: relative;
  outline: none;
}

.action:hover {
  background-color: var(--browser-action-hover-bg, rgba(255, 255, 255, 0.3));
}

.badge {
  box-shadow: 0px 0px 1px 1px var(--browser-action-badge-outline, #444);
  box-sizing: border-box;
  max-width: 100%;
  height: 12px;
  padding: 0 2px;
  border-radius: 2px;
  position: absolute;
  bottom: 1px;
  right: 0;
  pointer-events: none;
  line-height: 1.5;
  font-size: 9px;
  font-weight: 400;
  overflow: hidden;
  white-space: nowrap;
}`
        shadowRoot.appendChild(style)
      }

      connectedCallback() {
        if (this.isConnected) {
          this.startObserving()
          this.fetchState()
        }
      }

      disconnectedCallback() {
        this.stopObserving()
      }

      attributeChangedCallback(name: string, oldValue: any, newValue: any) {
        if (oldValue === newValue) return

        if (this.isConnected) {
          this.fetchState()
        }
      }

      private startObserving() {
        if (this.observing) return
        browserAction.addEventListener('update', this.update)
        browserAction.addObserver(this.partition || DEFAULT_PARTITION)
        this.observing = true
      }

      private stopObserving() {
        if (!this.observing) return
        browserAction.removeEventListener('update', this.update)
        browserAction.removeObserver(this.partition || DEFAULT_PARTITION)
        this.observing = false
      }

      private fetchState = async () => {
        try {
          await browserAction.getState(this.partition || DEFAULT_PARTITION)
        } catch {
          console.error(
            `browser-action-list failed to update [tab: ${this.tab}, partition: '${this.partition}']`
          )
        }
      }

      private update = (state: any) => {
        const tabId =
          typeof this.tab === 'number' && this.tab >= 0 ? this.tab : state.activeTabId || -1

        // Create or update action buttons
        for (const action of state.actions) {
          let browserActionNode = this.shadowRoot?.querySelector(
            `[id=${action.id}]`
          ) as BrowserActionElement

          if (!browserActionNode) {
            const node = document.createElement('button', {
              is: 'browser-action',
            }) as BrowserActionElement
            node.id = action.id
            node.className = 'action'
            ;(node as any).part = 'action'
            browserActionNode = node
            this.shadowRoot?.appendChild(browserActionNode)
          }

          if (this.partition) browserActionNode.partition = this.partition
          browserActionNode.tab = tabId
        }

        // Remove any actions no longer in use
        const actionNodes = Array.from(
          this.shadowRoot?.querySelectorAll('.action') as any
        ) as BrowserActionElement[]
        for (const actionNode of actionNodes) {
          if (!state.actions.some((action: any) => action.id === actionNode.id)) {
            actionNode.remove()
          }
        }
      }
    }

    customElements.define('browser-action-list', BrowserActionListElement)
  }

  try {
    contextBridge.exposeInMainWorld('browserAction', browserAction)

    // Must execute script in main world to modify custom component registry.
    webFrame.executeJavaScript(`(${mainWorldScript}());`)
  } catch {
    // When contextIsolation is disabled, contextBridge will throw an error.
    // If that's the case, we're in the main world so we can just execute our
    // function.
    mainWorldScript()
  }
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/index.ts
```ts
export * from './browser'

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/preload.ts
```ts
import { injectExtensionAPIs } from './renderer'

// Only load within extension page context
if (location.href.startsWith('chrome-extension://')) {
  injectExtensionAPIs()
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/renderer/event.ts
```ts
import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

const listenerMap = new Map<string, number>()

export const addExtensionListener = (extensionId: string, name: string, callback: Function) => {
  const listenerCount = listenerMap.get(name) || 0

  if (listenerCount === 0) {
    // TODO: should these IPCs be batched in a microtask?
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }

  listenerMap.set(name, listenerCount + 1)

  ipcRenderer.addListener(formatIpcName(name), function (event, ...args) {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  })
}

export const removeExtensionListener = (extensionId: string, name: string, callback: any) => {
  if (listenerMap.has(name)) {
    const listenerCount = listenerMap.get(name) || 0

    if (listenerCount <= 1) {
      listenerMap.delete(name)

      ipcRenderer.send('crx-remove-listener', extensionId, name)
    } else {
      listenerMap.set(name, listenerCount - 1)
    }
  }

  ipcRenderer.removeListener(formatIpcName(name), callback)
}

```

path: /Users/dannybengal/dev/electron-chrome-extensions-production/src/renderer/index.ts
```ts
import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener } from './event'

export const injectExtensionAPIs = () => {
  interface ExtensionMessageOptions {
    noop?: boolean
    serialize?: (...args: any[]) => any[]
  }

  const invokeExtension = async function (
    extensionId: string,
    fnName: string,
    options: ExtensionMessageOptions = {},
    ...args: any[]
  ) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, args)
    }

    if (options.noop) {
      console.warn(`${fnName} is not yet implemented.`)
      if (callback) callback()
      return
    }

    if (options.serialize) {
      args = options.serialize(...args)
    }

    let result

    try {
      result = await ipcRenderer.invoke('crx-msg', extensionId, fnName, ...args)
    } catch (e) {
      // TODO: Set chrome.runtime.lastError?
      console.error(e)
      result = undefined
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, '(result)', result)
    }

    if (callback) {
      callback(result)
    } else {
      return result
    }
  }

  const electronContext = {
    invokeExtension,
    addExtensionListener,
    removeExtensionListener,
  }

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variable will be included!
  function mainWorldScript() {
    // Use context bridge API or closure variable when context isolation is disabled.
    const electron = ((window as any).electron as typeof electronContext) || electronContext

    const chrome = window.chrome || {}
    const extensionId = chrome.runtime?.id

    // NOTE: This uses a synchronous IPC to get the extension manifest.
    // To avoid this, JS bindings for RendererExtensionRegistry would be
    // required.
    const manifest: chrome.runtime.Manifest =
      (extensionId && chrome.runtime.getManifest()) || ({} as any)

    const invokeExtension =
      (fnName: string, opts: ExtensionMessageOptions = {}) =>
      (...args: any[]) =>
        electron.invokeExtension(extensionId, fnName, opts, ...args)

    function imageData2base64(imageData: ImageData) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      canvas.width = imageData.width
      canvas.height = imageData.height
      ctx.putImageData(imageData, 0, 0)

      return canvas.toDataURL()
    }

    class ExtensionEvent<T extends Function> implements chrome.events.Event<T> {
      constructor(private name: string) {}

      addListener(callback: T) {
        electron.addExtensionListener(extensionId, this.name, callback)
      }
      removeListener(callback: T) {
        electron.removeExtensionListener(extensionId, this.name, callback)
      }

      getRules(callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: string[], callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      hasListener(callback: T): boolean {
        throw new Error('Method not implemented.')
      }
      removeRules(ruleIdentifiers?: string[] | undefined, callback?: (() => void) | undefined): void
      removeRules(callback?: (() => void) | undefined): void
      removeRules(ruleIdentifiers?: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      addRules(
        rules: chrome.events.Rule[],
        callback?: ((rules: chrome.events.Rule[]) => void) | undefined
      ): void {
        throw new Error('Method not implemented.')
      }
      hasListeners(): boolean {
        throw new Error('Method not implemented.')
      }
    }

    class ChromeSetting implements Partial<chrome.types.ChromeSetting> {
      set() {}
      get() {}
      clear() {}
      // onChange: chrome.types.ChromeSettingChangedEvent
    }

    type DeepPartial<T> = {
      [P in keyof T]?: DeepPartial<T[P]>
    }

    type APIFactoryMap = {
      [apiName in keyof typeof chrome]: {
        shouldInject?: () => boolean
        factory: (base: DeepPartial<typeof chrome[apiName]>) => DeepPartial<typeof chrome[apiName]>
      }
    }

    /**
     * Factories for each additional chrome.* API.
     */
    const apiDefinitions: Partial<APIFactoryMap> = {
      browserAction: {
        shouldInject: () => !!manifest.browser_action,
        factory: (base) => {
          const api = {
            ...base,

            setTitle: invokeExtension('browserAction.setTitle'),
            getTitle: invokeExtension('browserAction.getTitle'),

            setIcon: invokeExtension('browserAction.setIcon', {
              serialize: (details: any) => {
                if (details.imageData) {
                  if (details.imageData instanceof ImageData) {
                    details.imageData = imageData2base64(details.imageData)
                  } else {
                    details.imageData = Object.entries(details.imageData).reduce(
                      (obj: any, pair: any[]) => {
                        obj[pair[0]] = imageData2base64(pair[1])
                        return obj
                      },
                      {}
                    )
                  }
                }

                return [details]
              },
            }),

            setPopup: invokeExtension('browserAction.setPopup'),
            getPopup: invokeExtension('browserAction.getPopup'),

            setBadgeText: invokeExtension('browserAction.setBadgeText'),
            getBadgeText: invokeExtension('browserAction.getBadgeText'),

            setBadgeBackgroundColor: invokeExtension('browserAction.setBadgeBackgroundColor'),
            getBadgeBackgroundColor: invokeExtension('browserAction.getBadgeBackgroundColor'),

            enable: invokeExtension('browserAction.enable', { noop: true }),
            disable: invokeExtension('browserAction.disable', { noop: true }),

            onClicked: new ExtensionEvent('browserAction.onClicked'),
          }

          return api
        },
      },

      commands: {
        factory: (base) => {
          return {
            ...base,
            getAll: invokeExtension('commands.getAll'),
            onCommand: new ExtensionEvent('commands.onCommand'),
          }
        },
      },

      contextMenus: {
        factory: (base) => {
          let menuCounter = 0
          const menuCallbacks: {
            [key: string]: chrome.contextMenus.CreateProperties['onclick']
          } = {}
          const menuCreate = invokeExtension('contextMenus.create')

          let hasInternalListener = false
          const addInternalListener = () => {
            api.onClicked.addListener((info, tab) => {
              const callback = menuCallbacks[info.menuItemId]
              if (callback && tab) callback(info, tab)
            })
            hasInternalListener = true
          }

          const api = {
            ...base,
            create: function (
              createProperties: chrome.contextMenus.CreateProperties,
              callback?: Function
            ) {
              if (typeof createProperties.id === 'undefined') {
                createProperties.id = `${++menuCounter}`
              }
              if (createProperties.onclick) {
                if (!hasInternalListener) addInternalListener()
                menuCallbacks[createProperties.id] = createProperties.onclick
                delete createProperties.onclick
              }
              menuCreate(createProperties, callback)
              return createProperties.id
            },
            update: invokeExtension('contextMenus.update', { noop: true }),
            remove: invokeExtension('contextMenus.remove'),
            removeAll: invokeExtension('contextMenus.removeAll'),
            onClicked: new ExtensionEvent<
              (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
            >('contextMenus.onClicked'),
          }

          return api
        },
      },

      cookies: {
        factory: (base) => {
          return {
            ...base,
            get: invokeExtension('cookies.get'),
            getAll: invokeExtension('cookies.getAll'),
            set: invokeExtension('cookies.set'),
            remove: invokeExtension('cookies.remove'),
            getAllCookieStores: invokeExtension('cookies.getAllCookieStores'),
            onChanged: new ExtensionEvent('cookies.onChanged'),
          }
        },
      },

      extension: {
        factory: (base) => {
          return {
            ...base,
            isAllowedIncognitoAccess: () => false,
            // TODO: Add native implementation
            getViews: () => [],
          }
        },
      },

      notifications: {
        factory: (base) => {
          return {
            ...base,
            clear: invokeExtension('notifications.clear'),
            create: invokeExtension('notifications.create'),
            getAll: invokeExtension('notifications.getAll'),
            getPermissionLevel: invokeExtension('notifications.getPermissionLevel'),
            update: invokeExtension('notifications.update'),
            onClicked: new ExtensionEvent('notifications.onClicked'),
            onButtonClicked: new ExtensionEvent('notifications.onButtonClicked'),
            onClosed: new ExtensionEvent('notifications.onClosed'),
          }
        },
      },

      privacy: {
        factory: (base) => {
          return {
            ...base,
            network: {
              networkPredictionEnabled: new ChromeSetting(),
              webRTCIPHandlingPolicy: new ChromeSetting(),
            },
            websites: {
              hyperlinkAuditingEnabled: new ChromeSetting(),
            },
          }
        },
      },

      runtime: {
        factory: (base) => {
          return {
            ...base,
            openOptionsPage: invokeExtension('runtime.openOptionsPage'),
          }
        },
      },

      storage: {
        factory: (base) => {
          const local = base && base.local
          return {
            ...base,
            // TODO: provide a backend for browsers to opt-in to
            managed: local,
            sync: local,
          }
        },
      },

      tabs: {
        factory: (base) => {
          const api = {
            ...base,
            create: invokeExtension('tabs.create'),
            executeScript: function (arg1: unknown, arg2: unknown, arg3: unknown) {
              // Electron's implementation of chrome.tabs.executeScript is in
              // C++, but it doesn't support implicit execution in the active
              // tab. To handle this, we need to get the active tab ID and
              // pass it into the C++ implementation ourselves.
              if (typeof arg1 === 'object') {
                api.query(
                  { active: true, windowId: chrome.windows.WINDOW_ID_CURRENT },
                  ([activeTab]: chrome.tabs.Tab[]) => {
                    api.executeScript(activeTab.id, arg1, arg2)
                  }
                )
              } else {
                ;(base.executeScript as typeof chrome.tabs.executeScript)(
                  arg1 as number,
                  arg2 as chrome.tabs.InjectDetails,
                  arg3 as () => {}
                )
              }
            },
            get: invokeExtension('tabs.get'),
            getCurrent: invokeExtension('tabs.getCurrent'),
            getAllInWindow: invokeExtension('tabs.getAllInWindow'),
            insertCSS: invokeExtension('tabs.insertCSS'),
            query: invokeExtension('tabs.query'),
            reload: invokeExtension('tabs.reload'),
            update: invokeExtension('tabs.update'),
            remove: invokeExtension('tabs.remove'),
            goBack: invokeExtension('tabs.goBack'),
            goForward: invokeExtension('tabs.goForward'),
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
            onReplaced: new ExtensionEvent('tabs.onReplaced'),
          }
          return api
        },
      },

      webNavigation: {
        factory: (base) => {
          return {
            ...base,
            getFrame: invokeExtension('webNavigation.getFrame'),
            getAllFrames: invokeExtension('webNavigation.getAllFrames'),
            onBeforeNavigate: new ExtensionEvent('webNavigation.onBeforeNavigate'),
            onCommitted: new ExtensionEvent('webNavigation.onCommitted'),
            onCompleted: new ExtensionEvent('webNavigation.onCompleted'),
            onCreatedNavigationTarget: new ExtensionEvent(
              'webNavigation.onCreatedNavigationTarget'
            ),
            onDOMContentLoaded: new ExtensionEvent('webNavigation.onDOMContentLoaded'),
            onErrorOccurred: new ExtensionEvent('webNavigation.onErrorOccurred'),
            onHistoryStateUpdated: new ExtensionEvent('webNavigation.onHistoryStateUpdated'),
            onReferenceFragmentUpdated: new ExtensionEvent(
              'webNavigation.onReferenceFragmentUpdated'
            ),
            onTabReplaced: new ExtensionEvent('webNavigation.onTabReplaced'),
          }
        },
      },

      webRequest: {
        factory: (base) => {
          return {
            ...base,
            onHeadersReceived: new ExtensionEvent('webRequest.onHeadersReceived'),
          }
        },
      },

      windows: {
        factory: (base) => {
          return {
            ...base,
            WINDOW_ID_NONE: -1,
            WINDOW_ID_CURRENT: -2,
            get: invokeExtension('windows.get'),
            getLastFocused: invokeExtension('windows.getLastFocused'),
            getAll: invokeExtension('windows.getAll'),
            create: invokeExtension('windows.create'),
            update: invokeExtension('windows.update'),
            remove: invokeExtension('windows.remove'),
            onCreated: new ExtensionEvent('windows.onCreated'),
            onRemoved: new ExtensionEvent('windows.onRemoved'),
            onFocusChanged: new ExtensionEvent('windows.onFocusChanged'),
          }
        },
      },
    }

    // Initialize APIs
    Object.keys(apiDefinitions).forEach((key: any) => {
      const apiName: keyof typeof chrome = key
      const baseApi = chrome[apiName] as any
      const api = apiDefinitions[apiName]!

      // Allow APIs to opt-out of being available in this context.
      if (api.shouldInject && !api.shouldInject()) return

      Object.defineProperty(chrome, apiName, {
        value: api.factory(baseApi),
        enumerable: true,
        configurable: true,
      })
    })

    // Remove access to internals
    delete (window as any).electron

    Object.freeze(chrome)

    void 0 // no return
  }

  try {
    // Expose extension IPC to main world
    contextBridge.exposeInMainWorld('electron', electronContext)

    // Mutate global 'chrome' object with additional APIs in the main world.
    webFrame.executeJavaScript(`(${mainWorldScript}());`)
  } catch {
    // contextBridge threw an error which means we're in the main world so we
    // can just execute our function.
    mainWorldScript()
  }
}

```

