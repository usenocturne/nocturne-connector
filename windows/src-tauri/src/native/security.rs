use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

pub fn protect(value: &str) -> Result<String, String> {
    transform(value.as_bytes(), true).map(|bytes| BASE64.encode(bytes))
}

pub fn unprotect(value: &str) -> Result<String, String> {
    let encoded = BASE64
        .decode(value)
        .map_err(|error| format!("Invalid protected session encoding: {error}"))?;
    let bytes = transform(&encoded, false)?;
    String::from_utf8(bytes).map_err(|error| format!("Protected session is not UTF-8: {error}"))
}

fn transform(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    if input.is_empty() {
        return Err("Cannot protect an empty session payload".to_string());
    }
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input
            .len()
            .try_into()
            .map_err(|_| "Session payload is too large".to_string())?,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output_blob = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if protect {
            CryptProtectData(
                &input_blob,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        } else {
            CryptUnprotectData(
                &input_blob,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output_blob,
            )
        }
    };
    if let Err(error) = result {
        return Err(format!("Windows data protection failed: {error}"));
    }
    if output_blob.pbData.is_null() || output_blob.cbData == 0 {
        return Err("Windows data protection returned an empty payload".to_string());
    }
    let output = unsafe {
        std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec()
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output_blob.pbData.cast())));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{protect, unprotect};

    #[test]
    fn current_user_data_protection_round_trips() {
        let protected = protect("nocturne-session-test").expect("DPAPI protect failed");
        assert_ne!(protected, "nocturne-session-test");
        assert_eq!(
            unprotect(&protected).expect("DPAPI unprotect failed"),
            "nocturne-session-test"
        );
    }
}
