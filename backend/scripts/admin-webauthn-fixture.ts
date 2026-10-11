/** 真实 ES256 签名的最小软件认证器，仅供隔离回归；服务端仍走官方验证器。 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

type CborValue = number | string | Buffer | CborValue[] | Map<number | string, CborValue>
const uint = (major: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value <= 0xff) return Buffer.from([(major << 5) | 24, value])
  if (value <= 0xffff) { const result = Buffer.alloc(3); result[0] = (major << 5) | 25; result.writeUInt16BE(value, 1); return result }
  const result = Buffer.alloc(5); result[0] = (major << 5) | 26; result.writeUInt32BE(value, 1); return result
}
const cbor = (value: CborValue): Buffer => {
  if (typeof value === 'number') return value >= 0 ? uint(0, value) : uint(1, -1 - value)
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([uint(3, bytes.length), bytes]) }
  if (Buffer.isBuffer(value)) return Buffer.concat([uint(2, value.length), value])
  if (Array.isArray(value)) return Buffer.concat([uint(4, value.length), ...value.map(cbor)])
  return Buffer.concat([uint(5, value.size), ...Array.from(value.entries()).flatMap(([key, item]) => [cbor(key), cbor(item)])])
}

export class TestWebauthnAuthenticator {
  readonly credentialId = randomBytes(32)
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = pair.privateKey
    this.publicKey = pair.publicKey
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  private authenticatorData(rpId: string, counter: number, register = false, uv = true, up = true) {
    const counterBytes = Buffer.alloc(4)
    counterBytes.writeUInt32BE(counter)
    const base = [createHash('sha256').update(rpId).digest(), Buffer.from([register ? (uv ? 0x45 : 0x41) : ((up ? 0x01 : 0) | (uv ? 0x04 : 0))]), counterBytes]
    if (!register) return Buffer.concat(base)
    const jwk = this.publicKey.export({ format: 'jwk' })
    const cose = cbor(new Map<number, CborValue>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
    ]))
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    return Buffer.concat([...base, Buffer.alloc(16), idLength, this.credentialId, cose])
  }

  registration(challenge: string, origin: string, rpId: string, uv = true,
    attestationFormat: 'none' | 'packed' | 'packed_bad_signature' | 'unknown' = 'none') {
    const clientDataJSON = this.clientData('webauthn.create', challenge, origin)
    const authData = this.authenticatorData(rpId, 0, true, uv)
    const attStmt = new Map<string, CborValue>()
    if (attestationFormat !== 'none') {
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey)
      if (attestationFormat === 'packed_bad_signature') signature[signature.length - 1] ^= 1
      attStmt.set('alg', -7)
      attStmt.set('sig', signature)
    }
    const attestationObject = cbor(new Map<string, CborValue>([
      ['fmt', attestationFormat === 'unknown' ? 'unknown-format' : attestationFormat === 'none' ? 'none' : 'packed'],
      ['attStmt', attStmt], ['authData', authData],
    ]))
    const id = this.credentialId.toString('base64url')
    return {
      id, rawId: id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
    }
  }

  authentication(challenge: string, origin: string, rpId: string, userHandle: string | null, counter: number, uv = true, up = true) {
    const clientDataJSON = this.clientData('webauthn.get', challenge, origin)
    const authenticatorData = this.authenticatorData(rpId, counter, false, uv, up)
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey)
    const id = this.credentialId.toString('base64url')
    return {
      id, rawId: id, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'), userHandle,
      },
    }
  }
}
