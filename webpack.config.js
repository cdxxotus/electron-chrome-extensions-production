const path = require("path");

const main = {
  mode: "development", // or "production" depending on your environment
  target: "electron-main",
  entry: {
    index: "./src/index.ts",
  },
  output: {
    path: path.join(__dirname, "dist"),
    filename: "[name].js",
    // https://github.com/webpack/webpack/issues/1114
    libraryTarget: "commonjs2",
  },
  node: {
    __dirname: false,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: path.resolve(__dirname, "src"),
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true, // Set to true if you want faster compilation
            },
          },
        ],
      },
    ],
  },
};

const preload = {
  mode: "development", // or "production" depending on your environment
  target: "electron-preload",
  entry: {
    preload: "./src/preload.ts",
  },
  output: {
    path: path.join(__dirname, "dist"),
    filename: "[name].js",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: path.resolve(__dirname, "src"),
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },
};

const libs = {
  mode: "development", // or "production" depending on your environment
  target: "electron-renderer", // or "electron-preload" if appropriate
  entry: {
    "browser-action": "./src/browser-action.ts",
  },
  output: {
    path: path.join(__dirname, "dist"),
    filename: "[name].js",
    libraryTarget: "commonjs2",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        include: path.resolve(__dirname, "src"),
        use: [
          {
            loader: "ts-loader",
            options: {
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },
};

module.exports = [main, preload, libs];
