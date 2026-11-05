import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
} from 'jose';

export const ALG = 'ES256';

export interface PublicJwk extends JWK {
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

/**
 * The issuer's signing keys.
 *
 * One ACTIVE ES256 (ECDSA P-256) key signs new verdicts. Retired public keys can stay in the
 * published JWKS so verdicts signed before a rotation keep verifying until they expire (five
 * minutes), after which a retired key can be dropped.
 *
 * `kid` is the RFC 7638 thumbprint of the public key, so it is derived, not invented, and a
 * verifier can look a key up by the `kid` in the token header.
 */
export class KeyRing {
  private constructor(
    readonly kid: string,
    private readonly signingKey: CryptoKey,
    private readonly privateJwk: JWK,
    private readonly publicKeys: PublicJwk[],
  ) {}

  static async generate(): Promise<KeyRing> {
    const { privateKey } = await generateKeyPair(ALG, { extractable: true });
    return KeyRing.fromPrivateJwk(await exportJWK(privateKey));
  }

  /** `privateJwk` must be an EC P-256 private JWK (it has `d`). `retired` are old PUBLIC JWKs. */
  static async fromPrivateJwk(privateJwk: JWK, retired: JWK[] = []): Promise<KeyRing> {
    if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d) {
      throw new Error('Signing key must be an EC P-256 private JWK (with "d")');
    }
    const { d: _d, ...pub } = privateJwk;
    const kid = await calculateJwkThumbprint(pub);
    const signingKey = (await importJWK({ ...privateJwk, alg: ALG }, ALG)) as CryptoKey;
    const active: PublicJwk = { ...pub, kid, alg: ALG, use: 'sig' };
    const old = await Promise.all(retired.map(async (k) => toPublic(k)));
    return new KeyRing(kid, signingKey, privateJwk, [active, ...old.filter((k) => k.kid !== kid)]);
  }

  get key(): CryptoKey {
    return this.signingKey;
  }

  /** The body of /.well-known/jwks.json. Never contains private material. */
  jwks(): { keys: PublicJwk[] } {
    return { keys: this.publicKeys };
  }

  /** For persisting a dev key. Treat the result as a secret. */
  exportPrivateJwk(): JWK {
    return this.privateJwk;
  }
}

async function toPublic(k: JWK): Promise<PublicJwk> {
  const { d: _d, ...pub } = k; // defensively strip any private part
  return { ...pub, kid: await calculateJwkThumbprint(pub), alg: ALG, use: 'sig' };
}
