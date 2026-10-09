// A stand-in for the Python kernel, for client.test.ts. It speaks the same
// frames and does what the request's model or query name tells it to.
const mode = process.argv[2]

function send(header, blob = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(json.length, 0)
  prefix.writeUInt32BE(blob.length, 4)
  process.stdout.write(Buffer.concat([prefix, json, blob]))
}

function fail(id, kind, message) {
  send({ id, ok: false, error: { kind, message } })
}

process.stderr.write(`fake kernel ${process.pid} starting\n`)
if (mode === 'die-at-start') {
  process.stderr.write('ModuleNotFoundError: no module named build123d\n')
  process.exit(1)
}
if (mode === 'noisy') {
  for (let i = 0; i < 500; i++) process.stderr.write(`line ${i}\n`)
  process.stderr.write('no newline at the end')
}

send({ event: 'ready', versions: { fake: '1' } })

let building = null
const cancelled = new Set() // query names already refused once

function handle(request) {
  const { id, op } = request
  if (op === 'build') {
    if (building !== null) fail(building, 'cancelled', 'replaced by a newer build')
    building = id
    send({ id, event: 'build.started', pid: process.pid })
    if (request.model === 'die.py') process.exit(3)
    if (request.model === 'hang.py') return
    if (request.model === 'nan.py') {
      // What Python's json writes for float('nan') unless told not to: not JSON.
      const json = Buffer.from(`{"id":${id},"ok":true,"scene":{"seconds":NaN}}`)
      const prefix = Buffer.alloc(8)
      prefix.writeUInt32BE(json.length, 0)
      process.stdout.write(Buffer.concat([prefix, json]))
      return
    }
    building = null
    if (request.model === 'bad.py') fail(id, 'exception', 'boom')
    else {
      const scene = { model: request.model, layouts: [], parts: [], seconds: request.timeout ?? 0, output: process.cwd() }
      send({ id, ok: true, scene }, Buffer.from([1, 2, 3, 4, 5]))
    }
  } else if (op === 'query') {
    if (request.name === 'always-cancelled' || (request.name === 'cancelled-once' && !cancelled.has(request.name))) {
      cancelled.add(request.name)
      fail(id, 'cancelled', 'a newer build replaced the one this query was sent to')
    } else if (request.name === 'bad-ref') fail(id, 'bad_ref', 'no part named x')
    else if (request.name === 'hang') return
    else send({ id, ok: true, result: { dir: request.dir, name: request.name, args: request.args, pid: process.pid } })
  } else if (op === 'cancel') {
    if (building !== null) fail(building, 'cancelled', 'cancelled by request')
    building = null
  } else if (op === 'shutdown') {
    process.exit(0)
  } else {
    fail(null, 'bad_request', `unknown op ${op}`)
  }
}

let data = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  data = Buffer.concat([data, chunk])
  while (data.length >= 8) {
    const end = 8 + data.readUInt32BE(0) + data.readUInt32BE(4)
    if (data.length < end) break
    const request = JSON.parse(data.toString('utf8', 8, 8 + data.readUInt32BE(0)))
    data = data.subarray(end)
    handle(request)
  }
})
process.stdin.on('end', () => process.exit(0))
