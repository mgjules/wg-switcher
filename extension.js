imports.gi.versions.Gio = "2.0";
imports.gi.versions.GLib = "2.0";
imports.gi.versions.GObject = "3.0";
imports.gi.versions.Gtk = "3.0";
imports.gi.versions.St = "1.0";

const {Gtk, Gio, St, GObject, GLib} = imports.gi;

const MessageTray = imports.ui.messageTray;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext.domain(Extension.uuid);
const _ = Gettext.gettext;

const WGSwitcher = GObject.registerClass(
    class WGSwitcher extends PanelMenu.Button{
        _init(){
            super._init(St.Align.START);

            Gtk.IconTheme.get_default().append_search_path(
                Extension.dir.get_child('icons').get_path());

            const box = new St.BoxLayout();
            this.icon = new St.Icon({style_class: 'system-status-icon'});
            box.add(this.icon);
            this.add_child(box);

            this.services_section = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.services_section);

            this._active_service = "";
            this._sourceId = 0;
            this._auto_update();
        }

        _load_services(){
            this._switches = [];
            this.services_section.actor.hide();
            if(this.services_section.numMenuItems > 0){
                this.services_section.removeAll();
            }

            const wgConfDir = Gio.File.new_for_path('/etc/wireguard');
            const children = wgConfDir.enumerate_children("*", 0, null);
            let file_info = null;
            while ((file_info = children.next_file(null)) !== null) {
                if (file_info.get_is_hidden() || Gio.FileType.DIRECTORY == file_info.get_file_type()) { continue; }
                const re = /(?:\.([^.]+))?$/;
                const ext = re.exec(file_info.get_display_name())[1];
                if (ext !== 'conf') { continue; }
                const filename = file_info.get_display_name().slice(0, -5);

                const serviceSwitch = new PopupMenu.PopupSwitchMenuItem(
                    filename.split(/_(.+)/)[1],
                    {active: false});
                serviceSwitch.label.set_name(filename);
                serviceSwitch.setToggleState(this._active_service === filename);
                serviceSwitch.connect('toggled', this._switch_service.bind(this)); 
                this._switches.push(serviceSwitch);
                this.services_section.addMenuItem(serviceSwitch);
                this.services_section.actor.show();
            }
            children.close(null);
        }

        _switch_service(widget, value){
            try {
                const service = widget.label.get_name();
                const status = ((value == true) ? 'up': 'down');
                let cmd = ['/usr/bin/wg-quick', status, service];
                if (this._active_service && this._active_service !== service) {
                    cmd = ["/usr/bin/wg-quick", 'down', this._active_service, '&&', ...cmd]
                }
                let proc = Gio.Subprocess.new(
                    ['pkexec', 'bash', '-c', `${cmd.join(" ")}`],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try{
                        proc.communicate_utf8_finish(res);
                        notify('WireGuard Switcher', service, status);
                        this._refresh();
                    }catch(e){
                        logError(e);
                    }
                });
            } catch (e) {
                logError(e);
            }
        }

        _refresh(){
            try{
                this._active_service = "";
                const proc = Gio.Subprocess.new(
                    ['wg'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [, , stderr] = proc.communicate_utf8_finish(res);
                        this._switches.forEach((serviceSwitch, index, array)=>{
                            const service = serviceSwitch.label.get_name();
                            const active = containsWord (stderr, service);
                            if(active){
                                this._active_service = service;
                            }
                            GObject.signal_handlers_block_by_func(serviceSwitch,
                                                        this._switch_service);
                            serviceSwitch.setToggleState(active);
                            GObject.signal_handlers_unblock_by_func(serviceSwitch,
                                                            this._switch_service);
                        });
                    } catch (e) {
                        logError(e);
                    }

                    this._set_icon_indicator(this._active_service !== "");
                });
            } catch (e) {
                logError(e);
            }
        }

        _set_icon_indicator(active){
            const status = active ? 'up' : 'down';
            const icon_str = `wg-${status}`;
            this.icon.set_gicon(this._get_icon(icon_str));
        }

        _get_icon(icon_name){
            const icon_file = Gio.File.new_for_path(`${Extension.path}/icons/${icon_name}.svg`)
            if(icon_file.query_exists(null) == false){
                return null;
            }
            
            return Gio.icon_new_for_string(icon_file.get_path());
        }

        _auto_update(){
            this._load_services();
            this._refresh();
            if(this._sourceId > 0){
                GLib.source_remove(this._sourceId);
            }
            this._sourceId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 5,
                () => {
                    this._load_services();
                    this._refresh();
                    return true;
                }
            );
        }

        disableAutoUpdate(){
            if(this._sourceId > 0){
                GLib.source_remove(this._sourceId);
            }
        }
    }
);

let wgswitcher;

function init(){
    // 
}

function enable(){
    wgswitcher = new WGSwitcher();
    Main.panel.addToStatusArea('WGSwitcher', wgswitcher, 0, 'right');
}

function disable() {
    wgswitcher.disableAutoUpdate();
    wgswitcher.destroy();
}

function containsWord(string, word) {
    return new RegExp('\\b' + word + '\\b').test(string);
}

function notify(msg, details, icon="up") {
    const source = new MessageTray.Source(Extension.uuid, icon);
    Main.messageTray.add(source);
    const notification = new MessageTray.Notification(source, msg, details);
    notification.setTransient(true);
    source.showNotification(notification);
}