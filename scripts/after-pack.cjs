// electron-builder afterPack hook — mac only.
//
// WHY (owner ruling 2026-10-13): mac.icon is the Icon Composer document
// (build/icon.icon); actool compiles it into Assets.car (the macOS 26
// Liquid Glass render) PLUS a backwards-compat icns — but actool's
// fallback icns caps at 256px (known actool behavior), which looks soft
// at Finder/Launchpad sizes on pre-Tahoe macOS. This hook swaps in the
// hand-packed full-res build/icon.icns (all 10 entries, 16→1024, packed
// via iconutil from the design's PNG exports) AFTER packaging and BEFORE
// signing, so:
//
//   macOS 26+  → Assets.car (CFBundleIconName) — true layered glass icon;
//   older mac  → icon.icns (CFBundleIconFile) — today's full-res flatten.
//
// Windows/Linux builds return immediately (their icons are static files:
// build/icon.ico / build/icon.png).
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const resourcesDir = path.join(appBundle, "Contents", "Resources");
	const assetsCar = path.join(resourcesDir, "Assets.car");
	if (!fs.existsSync(assetsCar) || fs.statSync(assetsCar).size === 0) {
		throw new Error(`[after-pack] missing or empty Assets.car at ${assetsCar}`);
	}
	const infoPlistPath = path.join(appBundle, "Contents", "Info.plist");
	const infoPlist = fs.readFileSync(infoPlistPath, "utf8");
	if (!/<key>CFBundleIconName<\/key>\s*<string>Icon<\/string>/.test(infoPlist)) {
		throw new Error(`[after-pack] Info.plist missing CFBundleIconName=Icon at ${infoPlistPath}`);
	}
	if (!/<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/.test(infoPlist)) {
		throw new Error(`[after-pack] Info.plist missing CFBundleIconFile=icon.icns at ${infoPlistPath}`);
	}
	const target = path.join(resourcesDir, "icon.icns");
	const source = path.join(context.packager.info.projectDir, "build", "icon.icns");
	fs.copyFileSync(source, target);
	console.log(`[after-pack] verified Assets.car + Info.plist and copied full-res fallback icns → ${target}`);
};
