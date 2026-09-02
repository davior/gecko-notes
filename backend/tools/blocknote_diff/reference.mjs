import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { readFileSync } from "node:fs";

const samples = JSON.parse(readFileSync(process.argv[2], "utf8"));
const editor = ServerBlockNoteEditor.create();
const out = [];
for (const md of samples) {
  out.push(await editor.tryParseMarkdownToBlocks(md));
}
console.log(JSON.stringify(out));
