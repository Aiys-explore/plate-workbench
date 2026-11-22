import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [installer, version] = process.argv.slice(2)
assert.ok(installer && version,'Pass a Windows installer with its .sig sidecar and the expected app version')
const tauri = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'))
const [, encodedKey] = Buffer.from(tauri.plugins.updater.pubkey,'base64').toString('utf8').trimEnd().split(/\r?\n/)
const keyPacket = Buffer.from(encodedKey,'base64')
assert.equal(keyPacket.length,42)
assert.equal(keyPacket.subarray(0,2).toString('ascii'),'Ed')
const publicKey = createPublicKey({
  key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),keyPacket.subarray(10)]),
  format:'der',type:'spki',
})
const sidecar = (await readFile(installer+'.sig','utf8')).trim()
const [, encodedSignature, trustedLine, encodedCommentSignature] =
  Buffer.from(sidecar,'base64').toString('utf8').trimEnd().split(/\r?\n/)
const packet = Buffer.from(encodedSignature,'base64')
assert.equal(packet.length,74)
assert.ok(packet.subarray(2,10).equals(keyPacket.subarray(2,10)),'Signature is for a different updater key')
const format = packet.subarray(0,2).toString('ascii')
assert.ok(format==='ED' || format==='Ed', 'Unexpected signature algorithm')
assert.ok(trustedLine.startsWith('trusted comment: '))
const comment = trustedLine.slice('trusted comment: '.length)
const fields = comment.split('\t')
assert.ok(fields.includes('version:'+version),'Signature does not attest the app version')
assert.ok(fields.includes('file:'+basename(installer)), 'Signature does not attest this package name')

const binary = await readFile(installer)
const signature = packet.subarray(10)
const valid = bytes => verify(null,format==='ED' ? createHash('blake2b512').update(bytes).digest() : bytes,publicKey,signature)
assert.ok(valid(binary),'Installer signature failed')
assert.ok(verify(null,Buffer.concat([signature,Buffer.from(comment,'utf8')]),publicKey,
  Buffer.from(encodedCommentSignature,'base64')),'Trusted comment signature failed')
const changed = Buffer.from(binary)
changed[changed.length-1] ^= 1
assert.ok(!valid(changed),'Changed installer passed signature verification')

console.log(JSON.stringify({installer:basename(installer),version,keyId:keyPacket.subarray(2,10).toString('hex').toUpperCase(),
  sha256:createHash('sha256').update(binary).digest('hex').toUpperCase(),bytes:binary.length,
  signatureValid:true,versionAndNameAttested:true,tamperRejected:true},null,2))
