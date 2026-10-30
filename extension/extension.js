// Stable loader. GNOME Shell caches an extension's JS for the whole session, so
// this file is deliberately tiny and rarely changes. All real behaviour lives in
// logic.js, which is re-read from disk on every Reload() - no re-login needed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="dev.sonux.WinProbe">
    <method name="Toggle"/>
    <method name="Reload">
      <arg type="s" direction="out" name="error"/>
    </method>
    <method name="Call">
      <arg type="s" direction="in" name="method"/>
      <arg type="s" direction="in" name="args_json"/>
      <arg type="s" direction="out" name="result_json"/>
    </method>
  </interface>
</node>`;

export default class WinProbe extends Extension {
    enable() {
        this._logic = null;
        this._load();
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._impl.export(Gio.DBus.session, '/dev/sonux/WinProbe');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'dev.sonux.WinProbe',
            Gio.BusNameOwnerFlags.NONE, null, null, null);
    }

    disable() {
        this._unload();
        if (this._impl) { this._impl.unexport(); this._impl = null; }
        if (this._owner) { Gio.bus_unown_name(this._owner); this._owner = 0; }
    }

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(`${this.path}/logic.js`);
            const factory = new Function('deps', new TextDecoder().decode(bytes));
            this._logic = factory({Gio, GLib, Meta, St, Clutter, Shell, Main});
            return '';
        } catch (e) {
            console.error(`[winprobe] logic.js failed to load: ${e}\n${e.stack}`);
            this._logic = null;
            return String(e);
        }
    }

    _unload() {
        try { this._logic?.destroy(); } catch (e) { console.error(`[winprobe] destroy failed: ${e}`); }
        this._logic = null;
    }

    Reload() {
        this._unload();
        return this._load();
    }

    Toggle() {
        try { this._logic?.Toggle(); } catch (e) { console.error(`[winprobe] Toggle failed: ${e}\n${e.stack}`); }
    }

    Call(method, argsJson) {
        const fn = this._logic?.[method];
        if (typeof fn !== 'function' || method.startsWith('_') || method === 'destroy')
            return JSON.stringify({error: `no such method: ${method}`});
        try {
            const result = fn.apply(this._logic, JSON.parse(argsJson || '[]'));
            return JSON.stringify(result ?? null);
        } catch (e) {
            console.error(`[winprobe] ${method} failed: ${e}\n${e.stack}`);
            return JSON.stringify({error: String(e)});
        }
    }
}
