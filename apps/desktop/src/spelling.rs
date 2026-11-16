// The editor replaces the webview's context menu, which hides the webview's own
// spelling suggestions and "Add to dictionary". On Windows, WebView2 checks
// spelling with the Windows spell checker, so asking it directly gives the same
// verdicts, and words added here stop being underlined in the editor too.

// WebView2 spell checks in the Windows display language. Users can choose
// another language; it applies when the next launch creates the webview.

#[derive(serde::Serialize)]
pub(crate) struct Misspelling {
    suggestions: Vec<String>,
}

/// Returns `None` when the word is spelled correctly in the webview's spelling
/// language, or when this platform has no spell checker to ask.
#[tauri::command]
pub(crate) fn check_spelling(word: String) -> Option<Misspelling> {
    #[cfg(windows)]
    {
        windows_spelling::check(&word, &language::active())
            .map_err(|error| eprintln!("Unable to check spelling: {error}"))
            .ok()
            .flatten()
    }
    #[cfg(not(windows))]
    {
        let _ = word;
        None
    }
}

#[tauri::command]
pub(crate) fn add_to_dictionary(word: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_spelling::add(&word).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = word;
        Err("Spelling dictionaries are not available on this platform".into())
    }
}

#[derive(serde::Serialize)]
pub(crate) struct SpellingLanguages {
    available: Vec<String>,
    selected: Option<String>,
}

#[tauri::command]
pub(crate) fn spelling_languages(app: tauri::AppHandle) -> SpellingLanguages {
    #[cfg(windows)]
    {
        let identifier = &app.config().identifier;
        SpellingLanguages {
            available: windows_spelling::languages()
                .map_err(|error| eprintln!("Unable to list spelling languages: {error}"))
                .unwrap_or_default(),
            selected: language::saved(identifier),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        SpellingLanguages { available: Vec::new(), selected: None }
    }
}

/// `None` returns to the Windows display language.
#[tauri::command]
pub(crate) fn set_spelling_language(app: tauri::AppHandle, language: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        language::save(&app.config().identifier, language.as_deref()).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, language);
        Err("Choosing a spelling language is only available on Windows".into())
    }
}

/// Call before the webview is created.
pub(crate) fn apply_saved_language(identifier: &str) {
    #[cfg(windows)]
    language::apply(identifier);
    #[cfg(not(windows))]
    let _ = identifier;
}

#[cfg(windows)]
mod language {
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES, MAX_LOCALE_NAME};

    // The language chosen when this launch created the webview.
    static LAUNCHED: OnceLock<Option<String>> = OnceLock::new();

    const VARIABLE: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    // Setting browser arguments replaces the ones wry passes by default.
    const WRY_DEFAULT_ARGUMENTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

    // Tauri's app data directory, which the webview needs before Tauri starts.
    fn path(identifier: &str) -> Option<PathBuf> {
        Some(PathBuf::from(std::env::var_os("APPDATA")?).join(identifier).join("spelling-language"))
    }

    // The tag goes onto the browser command line, so allow only tag characters.
    fn valid(tag: &str) -> bool {
        !tag.is_empty() && tag.len() <= 35 && tag.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }

    pub(super) fn saved(identifier: &str) -> Option<String> {
        let tag = std::fs::read_to_string(path(identifier)?).ok()?;
        let tag = tag.trim();
        valid(tag).then(|| tag.to_owned())
    }

    pub(super) fn save(identifier: &str, tag: Option<&str>) -> std::io::Result<()> {
        let path = path(identifier).ok_or_else(|| std::io::Error::other("No app data directory"))?;
        match tag {
            Some(tag) if valid(tag) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, tag)
            }
            Some(_) => Err(std::io::Error::other("Not a language tag")),
            None => match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            },
        }
    }

    // The language the webview spell checks in: the saved choice it launched
    // with, or the Windows display language, which wry gives WebView2.
    pub(super) fn active() -> String {
        LAUNCHED.get().cloned().flatten().unwrap_or_else(|| {
            let mut name = [0u16; MAX_LOCALE_NAME as usize];
            let length = unsafe { LCIDToLocaleName(GetUserDefaultUILanguage() as u32, Some(&mut name), LOCALE_ALLOW_NEUTRAL_NAMES) };
            String::from_utf16_lossy(&name[..(length.max(1) - 1) as usize])
        })
    }

    pub(super) fn apply(identifier: &str) {
        let Some(tag) = LAUNCHED.get_or_init(|| saved(identifier)).clone() else { return };
        let arguments = std::env::var(VARIABLE).unwrap_or_else(|_| WRY_DEFAULT_ARGUMENTS.to_owned());
        std::env::set_var(VARIABLE, format!("{arguments} --lang={tag}"));
    }
}

#[cfg(windows)]
mod windows_spelling {
    use super::Misspelling;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{
        ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory, CORRECTIVE_ACTION_NONE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    fn factory() -> windows::core::Result<ISpellCheckerFactory> {
        // The webview's thread already has COM; this only matters elsewhere.
        // S_FALSE and RPC_E_CHANGED_MODE both leave COM usable here.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }
    }

    fn strings(list: IEnumString) -> Vec<String> {
        let mut values = Vec::new();
        loop {
            let mut item = [PWSTR::null()];
            let mut fetched = 0;
            let result = unsafe { list.Next(&mut item, Some(&mut fetched)) };
            if result.is_err() || fetched == 0 {
                return values;
            }
            values.push(unsafe { item[0].to_string() }.unwrap_or_default());
            unsafe { CoTaskMemFree(Some(item[0].0 as *const _)) };
        }
    }

    // The dictionaries for these languages, or every installed dictionary.
    fn checkers(
        factory: &ISpellCheckerFactory,
        preferred: &[String],
    ) -> windows::core::Result<Vec<ISpellChecker>> {
        let supported = strings(unsafe { factory.SupportedLanguages()? });
        let mut languages: Vec<&String> = preferred
            .iter()
            .filter_map(|tag| {
                supported.iter().find(|language| language.eq_ignore_ascii_case(tag)).or_else(|| {
                    let base = tag.split('-').next()?;
                    supported.iter().find(|language| {
                        language.split('-').next().is_some_and(|other| other.eq_ignore_ascii_case(base))
                    })
                })
            })
            .collect();
        languages.dedup();
        if languages.is_empty() {
            languages = supported.iter().collect();
        }
        languages
            .into_iter()
            .map(|language| unsafe { factory.CreateSpellChecker(&HSTRING::from(language.as_str())) })
            .collect()
    }

    pub(super) fn languages() -> windows::core::Result<Vec<String>> {
        Ok(strings(unsafe { factory()?.SupportedLanguages()? }))
    }

    pub(super) fn check(word: &str, language: &str) -> windows::core::Result<Option<Misspelling>> {
        let factory = factory()?;
        let checkers = checkers(&factory, &[language.to_owned()])?;
        let text = HSTRING::from(word);
        let mut suggestions = Vec::new();
        for checker in &checkers {
            let errors = unsafe { checker.Check(&text)? };
            let mut error = None;
            let _ = unsafe { errors.Next(&mut error) };
            let Some(error) = error else { return Ok(None) };
            if unsafe { error.CorrectiveAction()? } == CORRECTIVE_ACTION_NONE {
                return Ok(None);
            }
            if suggestions.is_empty() {
                suggestions = strings(unsafe { checker.Suggest(&text)? });
            }
        }
        if checkers.is_empty() {
            return Ok(None);
        }
        suggestions.retain(|suggestion| suggestion != word);
        suggestions.truncate(5);
        Ok(Some(Misspelling { suggestions }))
    }

    // Windows keeps one user dictionary per language, so add the word to all
    // of them, as the webview's own "Add to dictionary" does.
    pub(super) fn add(word: &str) -> windows::core::Result<()> {
        let factory = factory()?;
        let text = HSTRING::from(word);
        for checker in checkers(&factory, &[])? {
            unsafe { checker.Add(&text)? };
        }
        Ok(())
    }
}
