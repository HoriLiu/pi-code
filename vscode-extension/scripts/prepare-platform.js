#!/usr/bin/env node
/**
 * 把 resources/pi-web（Next standalone 产物）整理成指定平台可用的形态。
 * 用法：node scripts/prepare-platform.js win32-x64
 *
 * 1. Next 在 .next/node_modules/ 下生成指向构建机绝对路径的 symlink，
 *    换到其他机器（尤其 Windows）必断。这里替换为指向包内 node_modules 的实体副本。
 * 2. Next trace 只带 node-pty 的 lib/、不带 pi-tui 的 native/，
 *    这里从源 node_modules 补齐目标平台的 prebuild。
 * 3. 删除其他平台的原生二进制（sharp-linux-x64 等）以及被误 trace 进来的
 *    仓库目录（vscode-extension、demo、e2e、docs）。
 */
const fs = require("fs");
const path = require("path");

const target = process.argv[2] || "win32-x64";
const [platform, arch] = target.split("-");
const repoRoot = path.resolve(__dirname, "..", "..");
const outRoot = path.resolve(__dirname, "..", "resources", "pi-web");
const outModules = path.join(outRoot, "node_modules");
const srcModules = path.join(repoRoot, "node_modules");

if (!fs.existsSync(path.join(outRoot, "server.js"))) {
  throw new Error("resources/pi-web/server.js 不存在，请先运行 package:pi-web");
}

// 1) symlink → 实体目录
const nextModules = path.join(outRoot, ".next", "node_modules");
function walkLinks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(full);
      // 目标形如 <repo>/.next/standalone/node_modules/<pkg>，映射到包内 node_modules/<pkg>
      const marker = `${path.sep}node_modules${path.sep}`;
      const pkg = link.slice(link.lastIndexOf(marker) + marker.length);
      const local = path.join(outModules, pkg);
      if (!fs.existsSync(local)) throw new Error(`symlink 目标缺失: ${full} -> ${link}`);
      fs.rmSync(full);
      fs.cpSync(local, full, { recursive: true, dereference: true });
      console.log(`  symlink → 副本: ${path.relative(outRoot, full)}`);
    } else if (entry.isDirectory()) {
      walkLinks(full);
    }
  }
}
console.log("=== 替换 .next/node_modules 中的 symlink ===");
walkLinks(nextModules);

// 2) 补齐目标平台 prebuild
function copyDir(rel) {
  const src = path.join(srcModules, rel);
  if (!fs.existsSync(src)) throw new Error(`源文件缺失: ${src}`);
  for (const dest of findPackageCopies(rel)) {
    fs.cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`  补 ${path.relative(outRoot, dest)}`);
  }
}
// 一个包可能同时存在于 node_modules/<pkg> 与 .next/node_modules/<pkg>-<hash>
function findPackageCopies(rel) {
  const [pkgName, ...rest] = rel.startsWith("@") ? [rel.split("/").slice(0, 2).join("/"), ...rel.split("/").slice(2)] : rel.split("/");
  const dests = [path.join(outModules, pkgName, ...rest)];
  const scopeDir = path.join(nextModules, path.dirname(pkgName));
  const base = path.basename(pkgName);
  if (fs.existsSync(scopeDir)) {
    for (const name of fs.readdirSync(scopeDir)) {
      if (name.startsWith(base + "-")) dests.push(path.join(scopeDir, name, ...rest));
    }
  }
  return dests;
}
console.log(`=== 补齐 ${target} 原生模块 ===`);
copyDir(`node-pty/prebuilds/${target}`);
copyDir(`@earendil-works/pi-tui/native/${platform}/prebuilds/${target}`);

// 3) 清理
console.log("=== 清理其他平台二进制与多余目录 ===");
function rm(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  删除 ${path.relative(outRoot, p)}`);
  }
}
for (const dir of ["vscode-extension", "demo", "e2e", "docs", ".next/cache"]) rm(path.join(outRoot, dir));
const imgDir = path.join(outModules, "@img");
if (fs.existsSync(imgDir)) {
  for (const name of fs.readdirSync(imgDir)) {
    if (!name.includes(`${platform}-${arch}`)) rm(path.join(imgDir, name));
  }
}
// 任何残留的非目标平台 .node 文件
function walkNative(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkNative(full);
    else if (entry.name.endsWith(".node")) {
      const rel = path.relative(outRoot, full);
      const ok = rel.includes(target) || rel.includes(`${platform}-${arch}`);
      if (!ok) rm(full);
    }
  }
}
walkNative(outRoot);

// 被 trace 进来的仓库测试文件（含假 token，会触发 vsce 机密扫描），运行时用不到
function walkTests(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".next") walkTests(full);
    } else if (/\.test\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) {
      fs.rmSync(full);
    }
  }
}
walkTests(outRoot);

const leftLinks = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) leftLinks.push(f);
    else if (e.isDirectory()) scan(f);
  }
})(outRoot);
if (leftLinks.length) throw new Error(`仍有 symlink: ${leftLinks.join(", ")}`);
console.log(`✓ ${target} 整理完成`);
