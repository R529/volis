/** The only configuration the board wall needs. */

export const WORKBENCH_FOLDER = "画布";

export interface WorkbenchSettings {
  boardFolder: string;
}

export const DEFAULT_WORKBENCH_SETTINGS: WorkbenchSettings = {
  boardFolder: WORKBENCH_FOLDER,
};
