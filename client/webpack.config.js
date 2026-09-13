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

// Output names carry a content hash so they can be served `immutable`. Before
// this they were stamped with the package version alone, which meant every
// rebuild at the same version reused the same URL -- browsers held onto the
// first build they ever saw and four consecutive deploys changed nothing on
// screen. The version stays in the name too, purely so a file is still
// identifiable by eye.
const OUTPUT_JS = `js/[name].${packageJsonVersion}.[contenthash:8].min.js`;
const OUTPUT_CSS = `css/[name].${packageJsonVersion}.[contenthash:8].css`;

// The app build owns js/, and deletes anything in there it did not just emit --
// necessary now that names change on every content change, or the directory
// would grow a copy per build. The worker is produced by a second compiler that
// may still be running, so it is matched by prefix and left alone.
const isWorkerAsset = (fileName) => fileName.startsWith(`${WORKER_ENTRY}.`);

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
      filename: OUTPUT_JS,
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
    plugins: [
      // The worker URL is no longer predictable from the version, and the page
      // that starts the worker cannot read the app manifest for it either --
      // this is a different compilation. Write the name out so the server can
      // hand it to the client. A separate file rather than a shared one because
      // the two compilers run concurrently and would race on it.
      {
        apply(compiler) {
          compiler.hooks.emit.tapAsync('WorkerManifestPlugin', (compilation, callback) => {
            const files = compilation.entrypoints.get(WORKER_ENTRY).getFiles();
            const json = JSON.stringify({ [WORKER_ENTRY]: files[0] }, null, 2);
            compilation.assets['config/worker-manifest.json'] = {
              source: () => json,
              size: () => json.length,
            };
            callback();
          });

          // The app compiler's sweep deliberately skips every sse.client.* file,
          // so this compiler has to clear its own predecessors -- otherwise the
          // content hash leaves one behind on every content change.
          compiler.hooks.afterEmit.tapAsync('RemoveStaleWorkerAssets', (compilation, callback) => {
            const jsDir = path.join(compilation.compiler.outputPath, 'js');
            const current = new Set(compilation.entrypoints.get(WORKER_ENTRY).getFiles());
            if (fs.existsSync(jsDir)) {
              fs.readdirSync(jsDir, { withFileTypes: true }).forEach((file) => {
                if (file.isFile() && isWorkerAsset(file.name) && !current.has(`js/${file.name}`)) {
                  fs.unlinkSync(path.join(jsDir, file.name));
                  console.warn('Removed old worker asset: ', file.name);
                }
              });
            }
            callback();
          });
        },
      },
    ],
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
      filename: OUTPUT_JS,
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
        filename: OUTPUT_CSS,
      }),
      // splitChunks means an entry is no longer a single file, and content
      // hashes mean the templates could not name one even if it were. Emit
      // entry -> [files] (js and css both) and let the EJS render the tags in
      // dependency order.
      //
      // A CSS-only entry also emits a JS chunk containing nothing but webpack's
      // chunk-registration boilerplate, which no template loads. It is dropped
      // here rather than shipped as a stub, and kept out of the manifest in the
      // same pass so the manifest can never name a file that is not written.
      {
        apply(compiler) {
          compiler.hooks.emit.tapAsync('EntryManifestPlugin', (compilation, callback) => {
            const manifest = {};
            const entries = [...compilation.entrypoints].map(([name, entrypoint]) => ({
              name,
              files: entrypoint.getFiles(),
              isCssOnly: cssEntryNames.includes(name),
            }));

            // Everything a real entry needs. A CSS-only entry still gets the
            // shared runtime chunk in its file list -- runtimeChunk: 'single'
            // applies to every entry -- so its stub JS can only be dropped
            // after checking nothing else is relying on the same file.
            const scriptsInUse = new Set(
              entries
                .filter((entry) => !entry.isCssOnly)
                .flatMap((entry) => entry.files)
                .filter((file) => file.endsWith('.js'))
            );

            for (const { name, files, isCssOnly } of entries) {
              if (isCssOnly) {
                files
                  .filter((file) => file.endsWith('.js') && !scriptsInUse.has(file))
                  .forEach((file) => delete compilation.assets[file]);
              }
              manifest[name] = isCssOnly ? files.filter((file) => !file.endsWith('.js')) : files;
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
          // css as well as js now: both carry a content hash, so a stale build
          // no longer overwrites its predecessor and the directories would grow
          // a copy per build instead.
          ['js', 'css'].forEach((subDir) => {
            const dir = path.resolve(chosenBuildDir, subDir);
            if (!fs.existsSync(dir)) {
              return;
            }
            fs.readdirSync(dir, { withFileTypes: true }).forEach((file) => {
              if (!file.isFile()) {
                return;
              }
              // The worker is produced by the other compiler, which runs
              // concurrently with this one, so it is never in this
              // compilation's asset list and must not be swept up. Matched by
              // prefix because its hash changes with its contents.
              if (subDir === 'js' && isWorkerAsset(file.name)) {
                return;
              }
              // Assets are keyed "js/name.js" in the compilation.
              if (!newlyCreatedAssets[`${subDir}/${file.name}`]) {
                fs.unlinkSync(path.join(dir, file.name));
                unlinked.push(`${subDir}/${file.name}`);
              }
            });
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
