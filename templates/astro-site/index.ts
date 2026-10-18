// @siteoffer/astro-site の公開API。生成コンテナ・ワーカー・プレビューから使う。
export { type BuildSiteOptions, type BuildSiteResult, buildSite, TEMPLATE_DIR } from "./build/build-site.ts";
export {
  SITE_BUILD_REQUEST,
  SITE_BUILD_RESULT,
  siteBuildRequestSchema,
  siteBuildResultSchema,
} from "./build/protocol.ts";
export * from "./check/index.ts";
export { findMarkers, formatMarker, hasMarker, MARKER_LABEL, type MarkerHit, markerRegex } from "./lib/markers.ts";
export { MODE_ENV, resolveMode, validateSiteInput } from "./lib/resolve.ts";
export * from "./schema/site-generation.ts";
export * from "./schema/site-input.ts";
export * from "./schema/visual-design.ts";
