import { validateGapDistanceModelFile } from "@flight-route-explorer/route-engine/gap-distance";
import modelFile from "./generated/gap-distance-model.json";

export const BUNDLED_GAP_DISTANCE_MODEL = validateGapDistanceModelFile(modelFile);
