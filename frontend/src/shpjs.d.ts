// shpjs does not include types, and @types/shpjs is for an old version
declare module "shpjs" {
  import type { FeatureCollection } from "geojson";

  type ShapefileParts = {
    shp: ArrayBuffer;
    dbf?: ArrayBuffer;
    prj?: string;
    cpg?: string;
  };

  export default function shp(
    input: ShapefileParts | ArrayBuffer,
  ): Promise<FeatureCollection | FeatureCollection[]>;
}
