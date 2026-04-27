declare module "y-internal-y-sync" {
	import type { AnnotationType, Facet } from "@codemirror/state";
	import type { YSyncConfig } from "y-codemirror.next";

	export const ySyncFacet: Facet<YSyncConfig, YSyncConfig>;
	export const ySyncAnnotation: AnnotationType<YSyncConfig>;
}
