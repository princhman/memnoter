// The macOS menu bar. Custom items are sent to the webview as a `menu` event
// carrying the item's id; src/lib/menu-events.ts acts on them.

use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_EVENT: &str = "menu";

// (id, title, accelerator) of the items handled by the frontend.
const SETTINGS: (&str, &str, &str) = ("settings", "Settings…", "CmdOrCtrl+,");
const NEW_MODULE: (&str, &str, &str) = ("new-module", "New Module…", "CmdOrCtrl+N");
const FIND: (&str, &str, &str) = ("find", "Find…", "CmdOrCtrl+F");
const TOGGLE_SIDEBAR: (&str, &str, &str) = ("toggle-sidebar", "Toggle Sidebar", "CmdOrCtrl+D");

const CUSTOM_ITEMS: [&str; 4] = [SETTINGS.0, NEW_MODULE.0, FIND.0, TOGGLE_SIDEBAR.0];

fn item<R: Runtime>(
    app: &AppHandle<R>,
    (id, title, accelerator): (&str, &str, &str),
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    MenuItemBuilder::with_id(id, title)
        .accelerator(accelerator)
        .build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Memnoter")
        .about(None)
        .separator()
        .item(&item(app, SETTINGS)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&item(app, NEW_MODULE)?)
        .separator()
        .close_window()
        .build()?;

    // The predefined items keep the system clipboard and text-field shortcuts
    // working. The editor handles ⌘Z itself, before the menu sees it.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, FIND)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&item(app, TOGGLE_SIDEBAR)?)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if CUSTOM_ITEMS.contains(&id) {
        if let Err(error) = app.emit(MENU_EVENT, id) {
            eprintln!("Failed to send menu event {id}: {error}");
        }
    }
}
