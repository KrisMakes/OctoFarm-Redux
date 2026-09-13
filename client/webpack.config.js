const path = require('path');
const fs = require('fs');
const { fromPairs } = require('lodash');
const WebpackBeforeBuildPlugin = require('before-build-webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const webpack = require('webpack');

// Source
const basePath = './';
const clientJSFolder = basePath + '/entry/';
const clientCSSFolder = basePath + '/css/';
const clientImagesFolder = basePath + '/assets/';
const dirContents = fs.readdirSync(clientJSFolder, { withFileTypes: true });
const dirCssContents = fs.readdirSync(clientCSSFolder, { withFileTypes: true });

const packageJsonPath = path.join(__dirname, '../package.json');
const packageJsonVersion = require(packageJsonPath).version;

// Target
const buildDirProd = '../server/assets/';
const buildDirDev = basePath + 'assets/';

const webpackEntries = fromPairs(
  dirContents
    .filter((dirEntry) => dirEntry.isFile())
    .map((file) => {
      return [path.parse(file.name).name, clientJSFolder + file.name];
    })
    .concat(
      dirCssContents
        .filter((file) => file.name.includes('css'))
        .map((file) => [path.parse(file.name).name, clientCSSFolder + file.name])
    )
);

// CSS-only entries: webpack still emits a JS chunk for each, which nothing
// loads. Tracked so it can be dropped at emit time.
const cssEntryNames = dirCssContents
  .filter((file) => file.name.includes('css'))
  .map((file) => path.parse(file.name).name);

webpackEntries['vendor'] = `./js/vendor/entry.js`;
webpackEntries['bootstrap'] = 'bootstrap/dist/js/bootstrap.bundle';

// sse.client is loaded with `new Worker(url)`, which fetches exactly one file.
// It therefore cannot take part in code splitting at all: it needs its own
// runtime inlined and no shared chunks. The page entries need the opposite --
// ONE shared runtime, or their deferred startup (__webpack_require__.O waiting
// on the split chunk ids) never resolves and the entry code silently never
// runs. Those two requirements cannot be met by one compiler, so the worker is
// built by a second one below.
const WORKER_ENTRY = 'sse.client';
const workerEntry = webpackEntries[WORKER_ENTRY];
delete webpackEntries[WORKER_ENTRY];
const workerFileName = `js/${WORKER_ENTRY}.${packageJsonVersion}.min.js`;

/**
 * The web worker, built on its own.
 *
 * A worker fetches exactly one script, so this compiler must not split chunks
 * or extract a runtime. It writes into the same output directory as the app
 * build; nothing references it through the asset manifest because
 * client-worker.service.js constructs the URL directly.
 */
const workerConfig = (options) => {
  const isProd = options.mode === 'production';
  return {
    name: 'worker',
    entry: { [WORKER_ENTRY]: workerEntry },
    output: {
      filename: `js/[name].${packageJsonVersion}.min.js`,
      path: path.resolve(__dirname, isProd ? buildDirProd : buildDirDev),
    },
    mode: isProd ? 'production' : 'development',
    devtool: isProd ? false : 'source-map',
    target: 'webworker',
    optimization: {
      minimize: isProd,
      // Explicitly off: both would break `new Worker(url)`.
      runtimeChunk: false,
      splitChunks: false,
    },
    module: {
      rules: [
        {
          test: /\.(js)$/,
          exclude: /node_modules/,
          use: ['babel-loader'],
        },
      ],
    },
  };
};

const appConfig = (env, options) => {
  const isProd = options.mode === 'production';
  // bootstrap and vendor are loaded by layout.ejs as plain single script tags
  // ahead of everything else, so they stay self-contained.
  const standaloneEntries = new Set(['bootstrap', 'vendor']);
  const chosenBuildDir = isProd ? buildDirProd : buildDirDev;
  const fullDir = path.resolve(__dirname, chosenBuildDir);
  return {
    entry: webpackEntries,
    output: {
      filename: `js/[name].${packageJsonVersion}.min.js`,
      path: fullDir,
    },
    mode: isProd ? 'production' : 'development',
    devtool: isProd ? false : 'source-map',
    target: 'web',
    node: {
      global: false,
      __filename: false,
      __dirname: false,
    },
    externals: {
      jquery: 'jQuery',
      bootbox: 'bootbox',
    },
    optimization: {
      // Was `env.production`, which the build script never sets -- `--mode`
      // populates options.mode, not env. It only minified because webpack
      // treats undefined as "use the mode default".
      minimize: isProd,
      minimizer: [
        // For webpack@5 you can use the `...` syntax to extend existing minimizers (i.e. `terser-webpack-plugin`), uncomment the next line
        '...',
        new CssMinimizerPlugin(),
      ],
      // One runtime shared by every page entry. Without it each entry gets its
      // own, and an entry that defers startup on a split chunk id
      // (__webpack_require__.O) never starts -- the bundle loads, no error is
      // logged, and none of its code runs. The worker is built separately so
      // this does not apply to it.
      runtimeChunk: 'single',
      // splitChunks is the win here: without it every entry inlined its own
      // copy of ApexCharts (~495KB minified), lodash, Noty and Sortable, and
      // the five monitoring runners came out at 866KB each differing by under
      // 20 bytes.
      splitChunks: {
        chunks: (chunk) => !standaloneEntries.has(chunk.name),
        cacheGroups: {
          // ApexCharts on its own: it is the single biggest dependency and only
          // some pages draw charts.
          apexcharts: {
            test: /[\\/]node_modules[\\/]apexcharts[\\/]/,
            name: 'apexcharts',
            chunks: (chunk) => !standaloneEntries.has(chunk.name),
            priority: 30,
            reuseExistingChunk: true,
          },
          vendors: {
            test: /[\\/]node_modules[\\/]/,
            name: 'shared-vendor',
            chunks: (chunk) => !standaloneEntries.has(chunk.name),
            priority: 20,
            reuseExistingChunk: true,
          },
          // Our own modules that more than one entry pulls in.
          common: {
            name: 'shared-app',
            minChunks: 2,
            chunks: (chunk) => !standaloneEntries.has(chunk.name),
            priority: 10,
            reuseExistingChunk: true,
          },
        },
      },
    },
    module: {
      rules: [
        {
          test: /\.(js)$/,
          exclude: /node_modules/,
          use: ['babel-loader'],
        },
        // Only in dev: devtool is false for production builds, so this was pure
        // build-time cost there.
        ...(isProd
          ? []
          : [
              {
                test: /\.js$/,
                enforce: 'pre',
                use: ['source-map-loader'],
              },
            ]),
        {
          test: /\.css$/i,
          use: [
            MiniCssExtractPlugin.loader,
            {
              loader: 'css-loader',
              options: {
                url: false, // leave url() intact
                importLoaders: 1,
                sourceMap: true,
              },
            },
          ],
        },
      ],
    },
    plugins: [
      // Replaces the root package.json import in client-worker.service.js,
      // which inlined the entire manifest into every runner just to read
      // .version.
      new webpack.DefinePlugin({
        CLIENT_VERSION: JSON.stringify(packageJsonVersion),
      }),
      // new SourceMapDevToolPlugin(),
      new webpack.ProvidePlugin({
        // We dont bundle jquery
        // 'window.jQuery': 'jquery',
        Noty: 'Noty',
        // 'bootbox': 'bootbox',
      }),
      new MiniCssExtractPlugin({
        // filename: dirCssContents[0].name,
        filename: `css/[name].${packageJsonVersion}.css`,
      }),
      // A CSS-only entry still emits a JS chunk containing nothing but webpack's
      // chunk-registration boilerplate, and no template loads it. Drop it
      // rather than shipping a stub octofarm.<version>.min.js.
      {
        apply(compiler) {
          compiler.hooks.emit.tapAsync('RemoveCssOnlyEntryJs', (compilation, callback) => {
            for (const name of cssEntryNames) {
              delete compilation.assets[`js/${name}.${packageJsonVersion}.min.js`];
            }
            callback();
          });
        },
      },
      // splitChunks means an entry is no longer a single file, so the templates
      // cannot hard-code one script tag any more. Emit entry -> [files] and let
      // the EJS render the tags in dependency order.
      {
        apply(compiler) {
          compiler.hooks.emit.tapAsync('EntryManifestPlugin', (compilation, callback) => {
            const manifest = {};
            for (const [name, entrypoint] of compilation.entrypoints) {
              manifest[name] = entrypoint.getFiles().filter((file) => file.endsWith('.js'));
            }
            const json = JSON.stringify(manifest, null, 2);
            compilation.assets['config/asset-manifest.json'] = {
              source: () => json,
              size: () => json.length,
            };
            callback();
          });
        },
      },
      new WebpackBeforeBuildPlugin(
        function (stats, callback) {
          const newlyCreatedAssets = stats.compilation.assets;
          const unlinked = [];
          const jsDir = path.resolve(chosenBuildDir, 'js');
          if (!fs.existsSync(jsDir)) {
            callback();
            return;
          }
          const localDirContents = fs.readdirSync(jsDir, {
            withFileTypes: true,
          });
          localDirContents.forEach((file) => {
            if (!file.isFile()) {
              return;
            }
            // Assets are keyed "js/name.js" in the compilation.
            // The worker is produced by the other compiler, so it is not in
            // this compilation's asset list.
            if ('js/' + file.name === workerFileName) {
              return;
            }
            if (!newlyCreatedAssets['js/' + file.name]) {
              fs.unlinkSync(path.join(jsDir, file.name));
              unlinked.push(file.name);
            }
          });
          if (unlinked.length > 0) {
            console.warn('Removed old assets: ', unlinked);
          }

          callback();
        },
        ['done']
      ),
    ],
  };
};

module.exports = (env, options) => [appConfig(env, options), workerConfig(options)];
