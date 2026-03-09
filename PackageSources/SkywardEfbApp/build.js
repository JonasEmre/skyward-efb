const copyStaticFiles = require("esbuild-copy-static-files");
const globalExternals = require("@fal-works/esbuild-plugin-global-externals");
const { typecheckPlugin } = require("@jgoz/esbuild-plugin-typecheck");
const esbuild = require("esbuild");
const fs = require("fs");
const http = require("http");
const path = require("path");
const postcss = require("postcss");
const postCssUrl = require("postcss-url");
const postcssPrefixSelector = require("postcss-prefix-selector");
const sassPlugin = require("esbuild-sass-plugin");

require("dotenv").config({ path: __dirname + "/.env" });

const buildTarget = process.env.BUILD_TARGET === "preview" ? "preview" : "efb";
const isPreviewBuild = buildTarget === "preview";
const projectName = __dirname.split("\\").at(-1);
const outdir = isPreviewBuild ? "preview-dist" : "dist";
const baseUrl = isPreviewBuild
  ? `"."`
  : `"coui://html_ui/efb_ui/efb_apps/SkywardEfbApp"`;

const env = {
  typechecking: process.env.TYPECHECKING === "true",
  sourcemaps: process.env.SOURCE_MAPS === "true",
  minify: process.env.MINIFY === "true",
};

function getContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function serveStaticDirectory(rootDir, port) {
  const resolvedRoot = path.resolve(__dirname, rootDir);
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const relativePath =
      requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname.slice(1));
    const filePath = path.resolve(resolvedRoot, relativePath);

    if (!filePath.startsWith(resolvedRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let finalPath = filePath;
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) {
      finalPath = path.join(finalPath, "index.html");
    }

    if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(finalPath) });
    fs.createReadStream(finalPath).pipe(res);
  });

  server.listen(port, () => {
    console.log(`Preview available at http://127.0.0.1:${port}`);
  });
}

const plugins = [
  copyStaticFiles({
    src: "./src/Assets",
    dest: `./${outdir}/Assets`,
  }),
];

if (isPreviewBuild) {
  plugins.push(
    copyStaticFiles({
      src: "./src/preview/public",
      dest: `./${outdir}`,
    })
  );
} else {
  plugins.push(
    globalExternals.globalExternals({
      "@microsoft/msfs-sdk": {
        varName: "msfssdk",
        type: "cjs",
      },
      "@workingtitlesim/garminsdk": {
        varName: "garminsdk",
        type: "cjs",
      },
    })
  );
}

plugins.push(
  sassPlugin.sassPlugin({
    async transform(source) {
      const { css } = await postcss([
        postCssUrl({
          url: "copy",
        }),
        postcssPrefixSelector({
          prefix: `.efb-view.${projectName}`,
        }),
      ]).process(source, { from: undefined });
      return css;
    },
  })
);

const baseConfig = {
  entryPoints: [isPreviewBuild ? "src/preview/index.ts" : "src/SkywardEfbApp.tsx"],
  keepNames: true,
  bundle: true,
  outdir,
  outbase: "src",
  sourcemap: env.sourcemaps,
  minify: env.minify,
  logLevel: "debug",
  target: "es2017",
  define: { BASE_URL: baseUrl },
  plugins,
};

if (env.typechecking) {
  baseConfig.plugins.push(
    typecheckPlugin({ watch: process.env.SERVING_MODE === "WATCH" })
  );
}

if (process.env.SERVING_MODE === "WATCH") {
  esbuild.context(baseConfig).then((ctx) => ctx.watch());
} else if (process.env.SERVING_MODE === "SERVE") {
  const port = Number(process.env.PORT_SERVER || (isPreviewBuild ? 4173 : 8080));
  esbuild.context(baseConfig).then(async (ctx) => {
    await ctx.watch();
    if (isPreviewBuild) {
      serveStaticDirectory(outdir, port);
      return;
    }

    return ctx.serve({
      port,
      servedir: outdir,
    });
  });
} else if (["", undefined].includes(process.env.SERVING_MODE)) {
  esbuild.build(baseConfig);
} else {
  console.error(`MODE ${process.env.SERVING_MODE} is unknown`);
}
