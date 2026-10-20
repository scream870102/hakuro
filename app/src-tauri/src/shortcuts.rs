//! Persisted shortcut validation and transactional changes to the OS registry.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub const ACTIONS: [&str; 30] = [
    "commands",
    "playPause",
    "previous",
    "next",
    "seekBackward",
    "seekForward",
    "volumeUp",
    "volumeDown",
    "queue",
    "shuffle",
    "repeat",
    "refreshPlayback",
    "reconnect",
    "followLyrics",
    "translations",
    "findLyrics",
    "lyricsSource",
    "reloadLyrics",
    "compact",
    "alwaysOnTop",
    "clickThrough",
    "settings",
    "waveFull",
    "waveCompact",
    "minimize",
    "maximize",
    "turnFront",
    "turnRight",
    "turnBack",
    "turnLeft",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub action: String,
    pub accelerator: String,
    pub global: bool,
}

pub fn defaults() -> Vec<Binding> {
    ACTIONS
        .into_iter()
        .map(|action| Binding {
            action: action.into(),
            accelerator: match action {
                "commands" => "Ctrl+KeyK",
                "clickThrough" => "Ctrl+Alt+KeyP",
                _ => "",
            }
            .into(),
            global: action == "clickThrough",
        })
        .collect()
}

pub type Active = BTreeMap<u32, (Shortcut, String)>;

/// Validate local and global bindings together: a focused window must not fire twice.
pub fn validate(bindings: &mut [Binding]) -> Result<Active, String> {
    if bindings.len() > ACTIONS.len() {
        return Err("Too many shortcut bindings".into());
    }
    let mut actions = HashSet::new();
    let mut keys = HashSet::new();
    let mut globals = Active::new();
    for binding in bindings {
        if !ACTIONS.contains(&binding.action.as_str()) || !actions.insert(binding.action.clone()) {
            return Err(format!(
                "Unknown or duplicate shortcut action: {}",
                binding.action
            ));
        }
        let accelerator = binding.accelerator.trim();
        if accelerator.is_empty() {
            binding.accelerator.clear();
            continue;
        }
        if accelerator.len() > 100 {
            return Err("Shortcut is too long".into());
        }
        let shortcut: Shortcut = accelerator
            .parse()
            .map_err(|_| format!("Invalid shortcut for {}", binding.action))?;
        if !supported_key(shortcut.key)
            || (!shortcut
                .mods
                .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
                && !function_key(shortcut.key))
        {
            return Err(format!(
                "{} needs Ctrl, Alt or Super with a supported key, or F1–F24",
                binding.action
            ));
        }
        if !keys.insert(shortcut.id()) {
            return Err(format!("Shortcut {} is assigned more than once", shortcut));
        }
        binding.accelerator = canonical(shortcut);
        if binding.global {
            globals.insert(shortcut.id(), (shortcut, binding.action.clone()));
        }
    }
    Ok(globals)
}

pub(crate) fn canonical(shortcut: Shortcut) -> String {
    let mut parts = Vec::new();
    for (modifier, label) in [
        (Modifiers::CONTROL, "Ctrl"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Super"),
    ] {
        if shortcut.mods.contains(modifier) {
            parts.push(label.to_string());
        }
    }
    parts.push(shortcut.key.to_string());
    parts.join("+")
}

fn function_key(key: Code) -> bool {
    matches!(
        key,
        Code::F1
            | Code::F2
            | Code::F3
            | Code::F4
            | Code::F5
            | Code::F6
            | Code::F7
            | Code::F8
            | Code::F9
            | Code::F10
            | Code::F11
            | Code::F12
            | Code::F13
            | Code::F14
            | Code::F15
            | Code::F16
            | Code::F17
            | Code::F18
            | Code::F19
            | Code::F20
            | Code::F21
            | Code::F22
            | Code::F23
            | Code::F24
    )
}

fn supported_key(key: Code) -> bool {
    function_key(key)
        || matches!(
            key,
            Code::KeyA
                | Code::KeyB
                | Code::KeyC
                | Code::KeyD
                | Code::KeyE
                | Code::KeyF
                | Code::KeyG
                | Code::KeyH
                | Code::KeyI
                | Code::KeyJ
                | Code::KeyK
                | Code::KeyL
                | Code::KeyM
                | Code::KeyN
                | Code::KeyO
                | Code::KeyP
                | Code::KeyQ
                | Code::KeyR
                | Code::KeyS
                | Code::KeyT
                | Code::KeyU
                | Code::KeyV
                | Code::KeyW
                | Code::KeyX
                | Code::KeyY
                | Code::KeyZ
                | Code::Digit0
                | Code::Digit1
                | Code::Digit2
                | Code::Digit3
                | Code::Digit4
                | Code::Digit5
                | Code::Digit6
                | Code::Digit7
                | Code::Digit8
                | Code::Digit9
                | Code::ArrowUp
                | Code::ArrowDown
                | Code::ArrowLeft
                | Code::ArrowRight
                | Code::Space
                | Code::Enter
                | Code::Tab
                | Code::Backspace
                | Code::Delete
                | Code::Insert
                | Code::Home
                | Code::End
                | Code::PageUp
                | Code::PageDown
        )
}

/// Never use the plugin's non-atomic bulk API. Keep the actual map accurate even
/// if an OS rollback itself fails, and include that recovery failure in the error.
pub fn replace(
    active: &mut Active,
    desired: Active,
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let previous = active.clone();
    let outcome = (|| {
        for (id, (key, action)) in &desired {
            if !active.contains_key(id) {
                register(*key)?;
                active.insert(*id, (*key, action.clone()));
            }
        }
        for (id, (key, _)) in &previous {
            if !desired.contains_key(id) {
                unregister(*key)?;
                active.remove(id);
            }
        }
        save()
    })();
    if let Err(mut error) = outcome {
        for (id, (key, action)) in &previous {
            if !active.contains_key(id) {
                match register(*key) {
                    Ok(()) => {
                        active.insert(*id, (*key, action.clone()));
                    }
                    Err(rollback) => {
                        error.push_str(&format!("; could not restore {key}: {rollback}"));
                    }
                }
            }
        }
        for (id, (key, _)) in active.clone() {
            if !previous.contains_key(&id) {
                match unregister(key) {
                    Ok(()) => {
                        active.remove(&id);
                    }
                    Err(rollback) => {
                        error.push_str(&format!("; could not release {key}: {rollback}"));
                    }
                }
            }
        }
        return Err(error);
    }
    *active = desired;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn binding(action: &str, key: &str, global: bool) -> Binding {
        Binding {
            action: action.into(),
            accelerator: key.into(),
            global,
        }
    }

    #[test]
    fn validates_defaults_scope_duplicates_and_safe_keys() {
        assert_eq!(validate(&mut defaults()).unwrap().len(), 1);
        for key in [
            "KeyA",
            "Shift+KeyA",
            "Ctrl+Escape",
            "Ctrl",
            "Ctrl+MediaPlayPause",
        ] {
            assert!(
                validate(&mut [binding("playPause", key, true)]).is_err(),
                "{key}"
            );
        }
        for key in ["F24", "Ctrl+Space", "Super+ArrowUp"] {
            assert!(
                validate(&mut [binding("playPause", key, true)]).is_ok(),
                "{key}"
            );
        }
        assert!(validate(&mut [
            binding("playPause", "Ctrl+K", true),
            binding("commands", "Control+KeyK", false)
        ])
        .is_err());
        assert!(validate(&mut [binding("unknown", "", false)]).is_err());
        assert!(validate(&mut [
            binding("commands", "", false),
            binding("commands", "", true)
        ])
        .is_err());
        assert!(validate(&mut [binding("commands", "", true)])
            .unwrap()
            .is_empty());
        let mut aliases = [binding("playPause", "shift+control+alt+super+k", false)];
        validate(&mut aliases).unwrap();
        assert_eq!(aliases[0].accelerator, "Ctrl+Alt+Shift+Super+KeyK");
        assert!(defaults()
            .iter()
            .filter(|binding| binding.accelerator.is_empty())
            .all(|binding| !binding.global));
    }

    #[test]
    fn registration_conflict_and_disk_failure_restore_previous_keys() {
        let original = validate(&mut [binding("clickThrough", "Ctrl+Alt+P", true)]).unwrap();
        let desired = validate(&mut [binding("clickThrough", "Ctrl+Alt+Q", true)]).unwrap();
        let mut active = original.clone();
        assert!(replace(
            &mut active,
            desired.clone(),
            |_| Err("occupied".into()),
            |_| Ok(()),
            || panic!("must not save")
        )
        .is_err());
        assert_eq!(active, original);
        let os: RefCell<HashSet<u32>> = RefCell::new(original.keys().copied().collect());
        assert!(replace(
            &mut active,
            desired,
            |key| {
                os.borrow_mut().insert(key.id());
                Ok(())
            },
            |key| {
                os.borrow_mut().remove(&key.id());
                Ok(())
            },
            || Err("disk full".into())
        )
        .is_err());
        assert_eq!(active, original);
        assert_eq!(
            *os.borrow(),
            original.keys().copied().collect::<HashSet<_>>()
        );
    }

    #[test]
    fn partial_registration_failure_releases_new_keys_only() {
        let original = validate(&mut [binding("clickThrough", "Ctrl+Alt+P", true)]).unwrap();
        let mut active = original.clone();
        let desired = validate(&mut [
            binding("playPause", "Ctrl+Alt+Q", true),
            binding("next", "Ctrl+Alt+R", true),
        ])
        .unwrap();
        let os: RefCell<HashSet<u32>> = RefCell::new(original.keys().copied().collect());
        let mut calls = 0;
        assert!(replace(
            &mut active,
            desired,
            |key| {
                calls += 1;
                if calls == 2 {
                    return Err("occupied".into());
                }
                os.borrow_mut().insert(key.id());
                Ok(())
            },
            |key| {
                os.borrow_mut().remove(&key.id());
                Ok(())
            },
            || panic!("must not save")
        )
        .is_err());
        assert_eq!(active, original);
        assert_eq!(
            *os.borrow(),
            original.keys().copied().collect::<HashSet<_>>()
        );
    }

    #[test]
    fn action_swap_uses_existing_registration_and_clear_removes_it() {
        let mut active = validate(&mut [binding("clickThrough", "Ctrl+Alt+P", true)]).unwrap();
        let desired = validate(&mut [binding("playPause", "Ctrl+Alt+P", true)]).unwrap();
        replace(
            &mut active,
            desired,
            |_| panic!("already registered"),
            |_| panic!("still in use"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(active.values().next().unwrap().1, "playPause");
        replace(
            &mut active,
            Active::new(),
            |_| panic!("nothing new"),
            |_| Ok(()),
            || Ok(()),
        )
        .unwrap();
        assert!(active.is_empty());
    }
}
