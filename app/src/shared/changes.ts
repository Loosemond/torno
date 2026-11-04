// What a turn changed in the model's source files, as the sheet "See changes" shows it. Main reads the `.py` files
// directly in the project's folder when a prompt is sent and when the turn ends, and keeps the two texts of each file
// that differs, in memory only: never written to disk, never in `.torno/chat/`, never an item of the chat.

/** One source file of the project's folder that a turn changed. A file is named by its name in the folder (`hollow.py`). */
export interface FileChange {
  file: string
  /** The text at the start of the turn; null when the file was not there. */
  before: string | null
  /** The text at its end; null when the file was gone. */
  after: string | null
  /** The file was too large to keep (`MAX_FILE_BYTES`): it changed, and no text of it is held. */
  tooLarge?: true
}

export interface TurnChanges {
  files: FileChange[]
}

/** The largest source file whose text is kept, in bytes. */
export const MAX_FILE_BYTES = 200_000
