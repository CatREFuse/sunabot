import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function testTempRoot(name: string) {
  return path.join(fs.realpathSync(os.tmpdir()), `sunabot-${name}-${process.pid}`);
}
