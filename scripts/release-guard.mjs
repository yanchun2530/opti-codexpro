import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CODEXPRO_PACKAGE = "opti-codexpro";
export const CODEXPRO_REPOSITORY = "git+https://github.com/yanchun2530/opti-codexpro.git";
export const CODEXPRO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function releaseRootError(actualPath) {
  return new Error(
    `Release commands must run from the CodexPro root (${CODEXPRO_ROOT}). ` +
    `Current directory is ${actualPath}. Change directory first; do not use npm --prefix for npm pack or npm publish.`
  );
}

export function assertCodexProReleaseEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const actualCwd = canonicalPath(cwd);
  if (actualCwd !== CODEXPRO_ROOT) throw releaseRootError(actualCwd);

  if (env.INIT_CWD && canonicalPath(env.INIT_CWD) !== CODEXPRO_ROOT) {
    throw releaseRootError(canonicalPath(env.INIT_CWD));
  }

  const expectedPackageJson = resolve(CODEXPRO_ROOT, "package.json");
  if (env.npm_package_json && canonicalPath(env.npm_package_json) !== canonicalPath(expectedPackageJson)) {
    throw new Error("npm is bound to a different package.json; stop before packing or publishing.");
  }

  const packageJson = JSON.parse(readFileSync(expectedPackageJson, "utf8"));
  if (packageJson.name !== CODEXPRO_PACKAGE) {
    throw new Error(`Expected package name ${CODEXPRO_PACKAGE}; found ${packageJson.name ?? "(missing)"}.`);
  }
  if (packageJson.repository?.url !== CODEXPRO_REPOSITORY) {
    throw new Error("CodexPro repository metadata does not match the canonical release repository.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version ?? "")) {
    throw new Error("CodexPro package.json has an invalid release version.");
  }

  return {
    root: CODEXPRO_ROOT,
    name: packageJson.name,
    version: packageJson.version
  };
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectInvocation()) {
  try {
    const release = assertCodexProReleaseEnvironment();
    console.log(`CodexPro release guard: ${release.name}@${release.version}`);
  } catch (error) {
    console.error(`[release guard] ${error.message}`);
    process.exitCode = 1;
  }
}
