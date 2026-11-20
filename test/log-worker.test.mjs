import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("large retry backlog preserves duplicate logs and leaves the HTTP event loop responsive", () => {
  const directory = mkdtempSync(join(tmpdir(), "forest-worker-"));
  const path = join(directory, "queue.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE pending_log(id INTEGER PRIMARY KEY AUTOINCREMENT,row_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0); BEGIN");
    const insert = db.prepare("INSERT INTO pending_log(row_json,next_attempt_at) VALUES(?,?)");
    for (let i = 0; i < 100000; i++) insert.run('{"timestamp":"retry"}', Date.now() + 3600000);
    db.exec("COMMIT"); db.close();
    const program = `
      import { createServer } from 'node:http';
      import { DatabaseSync } from 'node:sqlite';
      import { DurableCoreLogForwarder } from './dist/logging/core-log-forwarder.js';
      let received=0;
      const receiver=createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}req.resume();req.on('end',()=>{received++;res.end('ok')});});
      await new Promise(r=>receiver.listen(0,'127.0.0.1',r));
      const queue=new DurableCoreLogForwarder(${JSON.stringify(path)},'http://127.0.0.1:'+receiver.address().port,1000);
      const row={timestamp:'same-packet',method:'POST',url:'http://test/',status:200,'구분':'DELIVER',durationMs:1,'user-agent':'test','request.body':null,'response.body':null};
      queue.enqueue(row);queue.enqueue(row);
      const db=new DatabaseSync(${JSON.stringify(path)});db.exec('PRAGMA busy_timeout=1000');
      if(db.prepare("SELECT COUNT(*) n FROM pending_log WHERE row_json LIKE '%same-packet%'").get().n!==2)process.exit(2);
      const started=performance.now();await new Promise(r=>setTimeout(r,20));
      await fetch('http://127.0.0.1:'+receiver.address().port+'/health');
      if(performance.now()-started>500)process.exit(3);
      const deadline=Date.now()+4000;while(received<2 && Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
      await new Promise(r=>setTimeout(r,100));
      const remaining=db.prepare('SELECT COUNT(*) n FROM pending_log').get().n;
      console.log(JSON.stringify({received,remaining}));process.exit(received===2&&remaining===100000?0:4);`;
    const result = spawnSync(process.execPath, ["--input-type=module"], { input: program, encoding:"utf8", timeout:10000, env:{...process.env,NODE_ENV:"test"} });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(directory, {recursive:true,force:true}); }
});
