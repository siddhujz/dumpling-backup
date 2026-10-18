import crypto from "node:crypto";
import { Transform } from "node:stream";

/**
 * OpenSSL-compatible "enc -aes-256-cbc -pbkdf2 -salt". Decrypt anywhere with:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -in file.enc -out file -pass pass:SECRET
 * Format: "Salted__" + 8-byte salt + AES-256-CBC(PKCS7) ciphertext; key and IV from
 * PBKDF2-HMAC-SHA256, 10000 iterations (OpenSSL's default).
 */
export function createOpenSslEncryptStream(passphrase: string): Transform {
  const salt = crypto.randomBytes(8);
  const keyIv = crypto.pbkdf2Sync(passphrase, salt, 10000, 48, "sha256");
  const cipher = crypto.createCipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
  let headerSent = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!headerSent) {
        headerSent = true;
        this.push(Buffer.concat([Buffer.from("Salted__"), salt]));
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([Buffer.from("Salted__"), salt]));
      cb(null, cipher.final());
    },
  });
}
