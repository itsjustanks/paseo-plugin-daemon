// Official Node SHASUMS256.txt verified 2026-10-12. Chrome hashes computed from
// these exact official CfT artifacts; version and revision resolved from CfT metadata.
export const NODE_VERSION = "24.20.0";
export const CHROME_VERSION = "155.0.8059.39";
export const CHROME_REVISION = "1697595";
export const ARTIFACTS = Object.freeze({
  "darwin-arm64": {
    node: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
    chromePlatform: "mac-arm64",
    chrome: "529a71bd61aaa2ef266a4d4bd300ae9572ba6a3468a8d55c3023ffeffb5b6b4e",
  },
  "linux-x64": {
    node: "855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec",
    chromePlatform: "linux64",
    chrome: "55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea",
  },
});
export function artifactsFor(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const pins = ARTIFACTS[target];
  if (!pins) throw new Error(`Workspace browser preparation supports macOS arm64 and Linux x64/glibc; received ${target}`);
  if (platform === "linux" && !process.report.getReport().header.glibcVersionRuntime)
    throw new Error("Workspace browser requires glibc Linux; musl is not supported");
  return { ...pins, target,
    nodeUrl: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.tar.gz`,
    chromeUrl: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${pins.chromePlatform}/chrome-${pins.chromePlatform}.zip`,
  };
}
