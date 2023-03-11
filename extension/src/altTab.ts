import Clutter from '@gi-types/clutter';
import GLib from '@gi-types/glib2';
import St from '@gi-types/st';
import Shell from '@gi-types/shell';
/*import { RectangleInt } from '@gi-types/cairo1';*/
import { global, imports } from 'gnome-shell';
import { AltTabConstants, ExtSettings } from '../constants';
import { TouchpadSwipeGesture } from './swipeTracker';
import { pixbuf_get_from_surface } from '@gi-types/gdk4';
import { File, FileCreateFlags } from '@gi-types/gio2';
import Cairo from '@gi-types/cairo1';
import { Window } from '@gi-types/meta';

const Main = imports.ui.main;
const { WindowSwitcherPopup } = imports.ui.altTab;

/*import Shell, { Screenshot } from '@gi-types/shell';
import { File, FileCreateFlags, MemoryOutputStream } from '@gi-types/gio2';*/


let dummyWinCount = AltTabConstants.DUMMY_WIN_COUNT;

function getIndexForProgress(progress: number, nelement: number): number {
	let index = Math.floor(progress * (nelement + 2 * dummyWinCount));
	index = index - dummyWinCount;
	return Math.clamp(index, 0, nelement - 1);
}

// index -> index + AltTabConstants.DUMMY_WIN_COUNT
function getAvgProgressForIndex(index: number, nelement: number): number {
	index = index + dummyWinCount;
	const progress = (index + 0.5) / (nelement + 2 * dummyWinCount);
	return progress;
}

// declare enum
enum AltTabExtState {
	DISABLED = 0,
	DEFAULT = 1,
	ALTTABDELAY = 2,
	ALTTAB = 3,
}

export class AltTabGestureExtension implements ISubExtension {
	private _connectHandlers: number[];
	private _touchpadSwipeTracker: typeof TouchpadSwipeGesture.prototype;
	private _adjustment: St.Adjustment;
	private _switcher?: typeof WindowSwitcherPopup.prototype;
	private _extState = AltTabExtState.DISABLED;
	private _progress = 0;
	private _altTabTimeoutId = 0;

	constructor() {
		this._connectHandlers = [];

		this._touchpadSwipeTracker = new TouchpadSwipeGesture(
			(ExtSettings.DEFAULT_SESSION_WORKSPACE_GESTURE ? [4] : [3]),
			Shell.ActionMode.ALL,
			Clutter.Orientation.HORIZONTAL,
			false,
			this._checkAllowedGesture.bind(this),
		);

		this._adjustment = new St.Adjustment({
			value: 0,
			lower: 0,
			upper: 1,
		});
	}

	_checkAllowedGesture(): boolean {
		return (
			this._extState <= AltTabExtState.DEFAULT && 
			Main.actionMode === Shell.ActionMode.NORMAL &&
			!(ExtSettings.APP_GESTURES && this._touchpadSwipeTracker.isItHoldAndSwipeGesture())
		);
	}

	apply(): void {
		this._adjustment.connect('notify::value', this._onUpdateAdjustmentValue.bind(this));

		this._connectHandlers.push(this._touchpadSwipeTracker.connect('begin', this._gestureBegin.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('update', this._gestureUpdate.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('end', this._gestureEnd.bind(this)));
		this._extState = AltTabExtState.DEFAULT;
	}

	destroy(): void {
		this._extState = AltTabExtState.DISABLED;
		this._connectHandlers.forEach(handle => this._touchpadSwipeTracker.disconnect(handle));

		this._touchpadSwipeTracker.destroy();
		this._connectHandlers = [];
		this._adjustment.run_dispose();

		if (this._switcher) {
			this._switcher.destroy();
			this._switcher = undefined;
		}
	}

	_onUpdateAdjustmentValue(): void {
		if (this._extState === AltTabExtState.ALTTAB && this._switcher) {
			const nelement = this._switcher._items.length;
			if (nelement > 1) {
				const n = getIndexForProgress(this._adjustment.value, nelement);
				this._switcher._select(n);
				const adjustment = this._switcher._switcherList._scrollView.hscroll.adjustment;
				const transition = adjustment.get_transition('value');
				if (transition) {
					transition.advance(AltTabConstants.POPUP_SCROLL_TIME);
				}
			}
		}
	}

	_gestureBegin(): void {
		log('gesture begin');
		const getMagicRow = (window: Window): number => {
			const offsets = {
				'google-chrome': [3, 10],  // maximized, non-maximized offset from top
				'gnome-terminal-server': [33, 33],
			};
			const index = window.maximizedHorizontally && window.maximizedVertically ? 0 : 1;
			const wmclass = window.wmClass.toLowerCase();
			const keys = Object.keys(offsets);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				if (wmclass.startsWith(key)) {
					return offsets[key as keyof typeof offsets][index];
				}
			}
			return 100;  // default when not found
		};

		const getStartPosition = (pixels: number[], window: Window): number => {
			// Pixels to exclude on left/right of an app
			// const exclude = {
			// 	'google-chrome': [0, 100],
			// };
			// Idea: get center of contiguous block of pixels, at least of size 5, that's closest to 0 or 1
			const group = pixels.reduce((accum: number[][], current: number, index: number): number[][] => {
				if (accum.length === 0 || accum[accum.length - 1][0] !== current) {
					accum.push([current, index, index]);
				} else {
					accum[accum.length - 1][2] = index;
				}
				return accum;
			}, []).map(elt => {  // convert color so close to extreme maps to more positive
				elt[0] = Math.abs(elt[0] - 0.5);
				return elt;
			}).reduce((prev: number[], current: number[]): number[] => {
				if (prev[0] > current[0])
					return prev;
				return current;
			});

			const ret = ((group[1] + group[2]) / 2) | 0;
			log('Move cursor to offset ' + ret + ' max: ' + window.maximizedHorizontally);
			return ret;
		};


		const actors = global.get_window_actors();
		const focused_window = global.display.get_focus_window();
		const focused_actors = actors.filter(windowactor => windowactor.meta_window === focused_window);
		if (focused_actors.length === 1) {
			log('have focused window');
			// const os = MemoryOutputStream.new_resizable();
			// const ss = Screenshot.new();
			// const cb = function() {
			// 	const bytes = os.steal_as_bytes();
			// 	const file = File.new_for_path('/tmp/data.buf');
			// 	const outstream = file.create(FileCreateFlags.NONE, null);
			// 	const byteswritten = outstream.write_bytes(bytes, null);
			// 	log('wrote ' + byteswritten + ' bytes to the file');
			// };
			// ss.screenshot_window(true, false, os, cb);


			const framerect = focused_window.get_frame_rect();
			framerect.height = Math.min(framerect.height, 32);
			// Mar 05 10:55:23 adlr-work.attlocal.net gnome-shell[67984]: framerect: 242, 5, 1373, 32
			// Mar 05 10:55:23 adlr-work.attlocal.net gnome-shell[67984]: wa: 220, -14, 1417, 1210

			log('framerect: ' + framerect.x + ', ' + framerect.y + ', ' + framerect.width + ', ' + framerect.height);

			const wa = focused_actors[0];
			log('wa: ' + wa.x + ', ' + wa.y + ', ' + wa.width + ', ' + wa.height);
			const kMagicRow = getMagicRow(focused_window);
			const rect = new Cairo.RectangleInt({
				x: framerect.x - wa.x,
				y: framerect.y - wa.y + kMagicRow,
				width: framerect.width,
				height: Math.min(framerect.height, 1),
			});
			log('rect: ' + rect.x + ', ' + rect.y + ', ' + rect.width + ', ' + rect.height);
			const surface = wa.get_image(rect);

			if (surface === null) {
				log('no surface!');
			} else {
				const pixbuf = pixbuf_get_from_surface(surface, 0, 0, rect.width, rect.height);
				if (pixbuf === null) {
					log('no pixbuf!');
				} else {
					// got the pixbuf!
					log('colorspace:' + pixbuf.get_colorspace() + ', bps:' + pixbuf.get_bits_per_sample() + ', hasAlpha:' +
						pixbuf.get_has_alpha() + ', channels:' + pixbuf.get_n_channels());
					const bytes = pixbuf.get_pixels();
					const bwvals = [];
					for (let i = 0; i < rect.width; i++) {
						const boff = i*4;
						bwvals.push((bytes[boff] + bytes[boff + 1] + bytes[boff + 2]) / (255 * 3));
						if ((i === 0) || (bwvals[i - 1] !== bwvals[i])) {
							log('Offset: ' + i + ', val: ' + bwvals[i]);
						}
					}
					
					const file = File.new_for_path('/tmp/data.buf');
					const outstream = file.create(FileCreateFlags.NONE, null);
					pixbuf.save_to_streamv(outstream, 'png', null, null, null);


					// Get mouse position
					const [mouse_x, mouse_y, _] = global.get_pointer();
					log('mouse is at ' + mouse_x + ', ' + mouse_y);
					const seat = Clutter.get_default_backend().get_default_seat();
					seat.warp_pointer(framerect.x + getStartPosition(bwvals, focused_window), framerect.y + kMagicRow);

					// const tex = wa.get_texture();
					// const itex = tex.get_texture();
					// const buf_width = itex.get_width();
					// const buf_height = itex.get_height();
					// const buf = new Uint8Array(buf_width * buf_height * 4);
					// const gdres = itex.get_data(/*PixelFormat.RGBA_8888*/ 83, 0, buf);
					// log('got data with size ' + buf_width + ' x ' + buf_height + ' with result: ' + gdres);
				}
			}
		} else {
			log('found ' + focused_actors.length + ' focused windows. not good');
		}
		this._progress = 0;
		if (this._extState === AltTabExtState.DEFAULT) {
			this._switcher = new WindowSwitcherPopup();
			this._switcher._switcherList.add_style_class_name('gie-alttab-quick-transition');
			this._switcher.connect('destroy', () => {
				this._switcher = undefined;
				this._reset();
			});

			// remove timeout entirely
			this._switcher._resetNoModsTimeout = function () {
				if (this._noModsTimeoutId) {
					GLib.source_remove(this._noModsTimeoutId);
					this._noModsTimeoutId = 0;
				}
			};
			const nelement = this._switcher._items.length;
			if (nelement > 0) {
				this._switcher.show(false, 'switch-windows', 0);
				this._switcher._popModal();

				if (this._switcher._initialDelayTimeoutId !== 0) {
					GLib.source_remove(this._switcher._initialDelayTimeoutId);
					this._switcher._initialDelayTimeoutId = 0;
				}

				const leftOver = AltTabConstants.MIN_WIN_COUNT - nelement;
				if (leftOver > 0) {
					dummyWinCount = Math.max(AltTabConstants.DUMMY_WIN_COUNT, Math.ceil(leftOver / 2));
				}
				else {
					dummyWinCount = AltTabConstants.DUMMY_WIN_COUNT;
				}

				if (nelement === 1) {
					this._switcher._select(0);
					this._progress = 0;
				} else {
					this._progress = getAvgProgressForIndex(1, nelement);
					this._switcher._select(1);
				}
				this._adjustment.value = 0;
				this._extState = AltTabExtState.ALTTABDELAY;
				this._altTabTimeoutId = GLib.timeout_add(
					GLib.PRIORITY_DEFAULT,
					AltTabConstants.DELAY_DURATION,
					() => {
						Main.osdWindowManager.hideAll();
						if (this._switcher)
							this._switcher.opacity = 255;
						this._adjustment.value = this._progress;
						this._extState = AltTabExtState.ALTTAB;
						this._altTabTimeoutId = 0;
						return GLib.SOURCE_REMOVE;
					},
				);
			} else {
				this._switcher.destroy();
				this._switcher = undefined;
			}
		}
	}

	_gestureUpdate(_gesture: never, _time: never, delta: number, distance: number): void {
		log('gesture update: ' + distance + ', ' + delta);
		if (this._extState > AltTabExtState.ALTTABDELAY) {
			this._progress = Math.clamp(this._progress + delta / distance, 0, 1);
			this._adjustment.value = this._progress;
		}
	}

	_gestureEnd(): void {
		log('gesture end');
		if (this._switcher) {
			const win = this._switcher._items[this._switcher._selectedIndex].window;
			Main.activateWindow(win);
			this._switcher.destroy();
			this._switcher = undefined;
		}

		this._reset();
	}

	private _reset() {
		if (this._extState > AltTabExtState.DEFAULT) {
			this._extState = AltTabExtState.DEFAULT;
			if (this._altTabTimeoutId) {
				GLib.source_remove(this._altTabTimeoutId);
				this._altTabTimeoutId = 0;
			}

			this._progress = 0;
			this._adjustment.value = 0;
		}
		this._extState = AltTabExtState.DEFAULT;
	}
}