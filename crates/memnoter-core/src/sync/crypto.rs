//! Native counterpart of src/lib/sync/crypto.ts. Keys stay on the device.
use crate::CommandResult;
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use unicode_normalization::UnicodeNormalization;

pub const PBKDF2_ITERATIONS: u32 = 600_000;

/// Derive the same AES key as WebCrypto, including NFKC passphrase normalization.
pub fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(
        passphrase.nfkc().collect::<String>().as_bytes(),
        salt,
        PBKDF2_ITERATIONS,
        &mut key,
    );
    key
}

pub fn new_salt() -> [u8; 16] {
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Wire format: version 1, random 12-byte nonce, ciphertext and 16-byte GCM tag.
pub fn encrypt_blob(key: &[u8; 32], doc: &str, plain: &[u8]) -> CommandResult<Vec<u8>> {
    let mut iv = [0; 12];
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(key.into());
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plain,
                aad: doc.as_bytes(),
            },
        )
        .map_err(|_| "Encryption failed".to_string())?;
    let mut blob = vec![1];
    blob.extend_from_slice(&iv);
    blob.extend(encrypted);
    Ok(blob)
}

pub fn decrypt_blob(key: &[u8; 32], doc: &str, blob: &[u8]) -> CommandResult<Vec<u8>> {
    if blob.len() < 29 || blob[0] != 1 {
        return Err("Unknown encrypted format".into());
    }
    Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&blob[1..13]),
            Payload {
                msg: &blob[13..],
                aad: doc.as_bytes(),
            },
        )
        .map_err(|_| "Decryption failed".to_string())
}

pub fn make_key_check(key: &[u8; 32]) -> CommandResult<Vec<u8>> {
    encrypt_blob(key, "key-check", b"memnoter-key-check")
}

pub fn verify_key_check(key: &[u8; 32], check: &[u8]) -> bool {
    decrypt_blob(key, "key-check", check).is_ok_and(|plain| plain == b"memnoter-key-check")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn webcrypto_wire_format_and_authenticated_document() {
        // Independent Node crypto fixture: PBKDF2 SHA256, 600000 rounds,
        // salt "salt", nonce [1;12], AES256 GCM with AAD "note".
        let key = derive_key("cafe\u{301}", b"salt");
        assert_eq!(
            key.as_slice(),
            hex("1c8c9f7d8dff1c2c9f4d27b430a716f340df3ca076d6714676293c836772a493")
        );
        let blob = hex("01010101010101010101010101ac6e359518cc186fbc9282bf4fb0f655c9e6627a00");
        assert_eq!(decrypt_blob(&key, "note", &blob).unwrap(), b"hello");
        assert!(decrypt_blob(&key, "other-note", &blob).is_err());
        let mut corrupt = blob;
        corrupt[13] ^= 1;
        assert!(decrypt_blob(&key, "note", &corrupt).is_err());
        assert!(decrypt_blob(&key, "note", &[1; 12]).is_err());
        assert!(verify_key_check(&key, &make_key_check(&key).unwrap()));
    }
}
