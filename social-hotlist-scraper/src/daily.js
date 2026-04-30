import { runCollect } from "./collect.js";

const result = await runCollect(process.argv.slice(2));

if (result) {
  console.log(`daily run completed: ${result.runDir}`);
  console.log(`latest snapshot: ${result.latestDir}`);
  console.log(`site entry: ${result.siteEntryFile}`);
}
