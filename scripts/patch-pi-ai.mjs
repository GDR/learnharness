import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "node_modules", "@earendil-works", "pi-ai");
const ASSETS_DIR = path.join(ROOT, "scripts", "assets");

export function patchPiAi(targetDir = DEFAULT_TARGET) {
    if (!fs.existsSync(targetDir)) {
        console.warn(`[patch-pi-ai] Target directory not found: ${targetDir} (skipping)`);
        return false;
    }

    const providersDir = path.join(targetDir, "dist", "providers");
    if (!fs.existsSync(providersDir)) {
        console.warn(`[patch-pi-ai] Providers directory not found: ${providersDir} (skipping)`);
        return false;
    }

    // 1. Copy antigravity.js and antigravity.d.ts
    const providerJsSrc = path.join(ASSETS_DIR, "antigravity-provider.js");
    const providerDtsSrc = path.join(ASSETS_DIR, "antigravity-provider.d.ts");
    const providerJsDest = path.join(providersDir, "antigravity.js");
    const providerDtsDest = path.join(providersDir, "antigravity.d.ts");

    fs.copyFileSync(providerJsSrc, providerJsDest);
    fs.copyFileSync(providerDtsSrc, providerDtsDest);

    // 2. Patch dist/providers/all.js
    const allJsPath = path.join(providersDir, "all.js");
    if (fs.existsSync(allJsPath)) {
        let allJs = fs.readFileSync(allJsPath, "utf8");

        if (!allJs.includes('import { antigravityProvider } from "./antigravity.js";')) {
            allJs = allJs.replace(
                'import { anthropicProvider } from "./anthropic.js";',
                'import { anthropicProvider } from "./anthropic.js";\nimport { antigravityProvider } from "./antigravity.js";',
            );
        }

        if (!allJs.includes("export { antigravityProvider };")) {
            allJs = allJs.replace(
                "export { radiusProvider };",
                "export { radiusProvider };\nexport { antigravityProvider };",
            );
        }

        if (!allJs.includes("antigravityProvider(),")) {
            allJs = allJs.replace(
                "anthropicProvider(),",
                "anthropicProvider(),\n        antigravityProvider(),",
            );
        }

        fs.writeFileSync(allJsPath, allJs, "utf8");
    }

    // 3. Patch dist/providers/all.d.ts
    const allDtsPath = path.join(providersDir, "all.d.ts");
    if (fs.existsSync(allDtsPath)) {
        let allDts = fs.readFileSync(allDtsPath, "utf8");

        if (!allDts.includes("antigravityProvider")) {
            allDts = allDts.replace(
                "export { radiusProvider };",
                'export { radiusProvider };\nexport { antigravityProvider } from "./antigravity.js";',
            );
            fs.writeFileSync(allDtsPath, allDts, "utf8");
        }
    }

    // 4. Patch dist/env-api-keys.js
    const envKeysPath = path.join(targetDir, "dist", "env-api-keys.js");
    if (fs.existsSync(envKeysPath)) {
        let envKeys = fs.readFileSync(envKeysPath, "utf8");

        if (!envKeys.includes('antigravity: "ANTIGRAVITY_OAUTH_TOKEN",')) {
            envKeys = envKeys.replace(
                '"ant-ling": "ANT_LING_API_KEY",',
                '"ant-ling": "ANT_LING_API_KEY",\n        antigravity: "ANTIGRAVITY_OAUTH_TOKEN",',
            );
            fs.writeFileSync(envKeysPath, envKeys, "utf8");
        }
    }

    console.log(`[patch-pi-ai] Successfully patched @earendil-works/pi-ai at: ${targetDir}`);
    return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET;
    patchPiAi(target);
}
