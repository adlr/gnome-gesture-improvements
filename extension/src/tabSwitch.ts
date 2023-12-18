import Clutter from '@gi-types/clutter';
import Shell from '@gi-types/shell';
/*import { RectangleInt } from '@gi-types/cairo1';*/
import { global, imports } from 'gnome-shell';
import { ExtSettings } from '../constants';
import { TouchpadSwipeGesture } from './swipeTracker';
import { pixbuf_get_from_surface } from '@gi-types/gdk4';
/*import { File, FileCreateFlags } from '@gi-types/gio2';*/
import Cairo from '@gi-types/cairo1';
import { Window } from '@gi-types/meta';
import * as GdkPixbuf from '@gi-types/gdkpixbuf2';
/*import Meta from '@gi-types/meta';*/

const Main = imports.ui.main;

function locateRightChromium(pixbuf: GdkPixbuf.Pixbuf, maximized: boolean): number | null {
	const bytes = pixbuf.get_pixels();

	// returns value in range: 0 -> black, 1 -> white
	const getPixel = (x: number, y: number): number => {
		if (x >= pixbuf.width || y >= pixbuf.height || x < 0 || y < 0) {
			log('Invalid request of getPixel. Out of bounds!');
			return 0;
		}
		const start = pixbuf.get_rowstride() * y + 4 * x;
		const ret = (bytes[start] + bytes[start + 1] + bytes[start + 2]) / (3 * 255);
		return ret;
	};

	const pixelValuesNear = (val_a: number, val_b: number): boolean => {
		const kMaxDarkColorDelta = 0.2;
		return Math.abs(val_a - val_b) < kMaxDarkColorDelta;
	};
	const getLeftCenterRight = (x_init: number, y_init: number): [number, number, number] => {
		let x_min = x_init;
		let x_max = x_init;
		const value = getPixel(x_init, y_init);
		while (x_min > 0) {
			if (!pixelValuesNear(getPixel(x_min - 1, y_init), value))
				break;
			x_min--;
		}
		while (x_max < (pixbuf.width - 1)) {
			if (!pixelValuesNear(getPixel(x_max + 1, y_init), value))
				break;
			x_max++;
		}
		return [x_min, ((x_min + x_max) / 2) | 0, x_max];
	};
	const getTopMidBottom = (x_init: number, y_init: number): [number, number, number] => {
		let y_min = y_init;
		let y_max = y_init;
		const value = getPixel(x_init, y_init);
		while (y_min > 0) {
			if (!pixelValuesNear(getPixel(x_init, y_min - 1), value))
				break;
			y_min--;
		}
		while (y_max < (pixbuf.height - 1)) {
			if (!pixelValuesNear(getPixel(x_init, y_max + 1), value))
				break;
			y_max++;
		}
		return [y_min, ((y_min + y_max) / 2) | 0, y_max];
	};
	// This function does a lot, but hopefully it bails out early 99% of the time
	const isPlus = (x: number, y: number): boolean => {
		const kMinWidth = 8;
		const kMaxWidth = 30;
		const kMinLineWidth = 2;
		const s1 = getLeftCenterRight(x, y);
		const s1_width = s1[2] - s1[0] + 1;
		if (s1_width < kMinLineWidth || s1_width > kMaxWidth)
			return false;
		const s2 = getTopMidBottom(s1[1], y);
		const s2_height = s2[2] - s2[0] + 1;
		if (s2_height < kMinWidth || s2_height > kMaxWidth)
			return false;
		const s3 = getLeftCenterRight(s1[1], s2[1]);
		const s3_width = s3[2] - s3[0] + 1;
		if (s3_width < kMinWidth || s3_width > kMaxWidth)
			return false;
		// Make sure roughly square
		if (Math.abs(s2_height - s3_width) > 3) {
			return false;
		}
		// Now, check line thickness at extremes
		// [x, y, scan_horiz]
		const start_coords : [number, number, boolean][] = [
			[s1[1], s2[0], true],
			[s1[1], s2[2], true],
			[s3[0], s2[1], false],
			[s3[2], s2[1], false],
		];
		const sizes = start_coords.map(coords => {
			const res = coords[2] ? getLeftCenterRight(coords[0], coords[1]) : getTopMidBottom(coords[0], coords[1]);
			return res[2] - res[0] + 1;
		});
		const min_thickness = Math.min(...sizes);
		const max_thickness = Math.max(...sizes);
		if (max_thickness - min_thickness > 2) {
			return false;
		}
		// Ensure line thickness is not too small or big
		if (min_thickness < kMinLineWidth || max_thickness * 3 > s3_width) {
			return false;
		}
		return true;
	};
	// Find the + on the right of the tabstrip. Start at the right and keep trying.
	const kSearchRow = maximized ? 16 : 23;
	const kMinSize = 20;
	if (pixbuf.width < kMinSize) {
		log('pixbuf too narrow');
		return null;
	}
	const background = getPixel(pixbuf.width - 2, kSearchRow);
	// First, look for a plus that's not the background color
	let x;
	for (x = pixbuf.width - 3; x > kMinSize; x--) {
		const value = getPixel(x, kSearchRow);
		if (value === background)
			continue;
		if (isPlus(x, kSearchRow))
			break;
	}
	if (x === kMinSize) {
		log('could not find a plus');
		return null;
	}
	// Search for background color again
	for (; x > kMinSize; x--) {
		const value = getPixel(x, kSearchRow);
		if (value !== background)
			continue;
		break;
	}
	if (x === kMinSize) {
		log('could not find bg color after plus');
		return null;
	}
	// Now, find the first pixel that's not background color
	for (; x > kMinSize; x--) {
		const value = getPixel(x, kSearchRow);
		if (value === background)
			continue;
		break;
	}
	if (x === kMinSize) {
		log('could not find non-bg color after plus');
		return null;
	}
	return x - 5;
}

function getBounds(window: Window, pixbuf: GdkPixbuf.Pixbuf): [number, number] {
	const frame = window.get_frame_rect();
	const ret : [number, number] = [frame.x, frame.x + frame.width - 1];
	if (window.wmClass.toLowerCase().startsWith('google-chrome')) {
		const maximized = window.maximizedHorizontally && window.maximizedVertically;
		// if (!maximized)
		// 	ret[0] = frame.x + 8;
		ret[0] = frame.x + 40;
		const right = locateRightChromium(pixbuf, maximized);
		if (right !== null)
			ret[1] = frame.x + right;
	}
	return ret;
}

export class TabSwitchGestureExtension implements ISubExtension {
	private _connectHandlers: number[];
	private _touchpadSwipeTracker: typeof TouchpadSwipeGesture.prototype;
	private _originalCursorPos: number[] | null;
	private _virtualPointer: Clutter.VirtualInputDevice;
	// When doing the gesture, the min and max x locations allowed
	private _bounds: number[] | null;
	private _lastNewX: number;
	private _shiftCapture: number;
	private _shiftCapture2: number;
	private _skipFinalClick: boolean;

	constructor() {
		this._connectHandlers = [];
		this._originalCursorPos = null;

		this._touchpadSwipeTracker = new TouchpadSwipeGesture(
			(ExtSettings.DEFAULT_SESSION_WORKSPACE_GESTURE ? [4] : [3]),
			Shell.ActionMode.ALL,
			Clutter.Orientation.HORIZONTAL,
			false,
			this._checkAllowedGesture.bind(this),
		);

		const seat = Clutter.get_default_backend().get_default_seat();
		this._virtualPointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
		this._bounds = null;
		this._lastNewX = -1;
		this._shiftCapture = 0;
		this._shiftCapture2 = 0;
		this._skipFinalClick = false;
	}

	_checkAllowedGesture(): boolean {
		return (
			Main.actionMode === Shell.ActionMode.NORMAL &&
			!(ExtSettings.APP_GESTURES && this._touchpadSwipeTracker.isItHoldAndSwipeGesture())
		);
	}

	apply(): void {
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('begin', this._gestureBegin.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('update', this._gestureUpdate.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('end', this._gestureEnd.bind(this)));
	}

	destroy(): void {
		this._connectHandlers.forEach(handle => this._touchpadSwipeTracker.disconnect(handle));

		this._touchpadSwipeTracker.destroy();
		this._connectHandlers = [];
	}

	_onKeyEvent(_stage : Clutter.Actor, event : Clutter.Event) {
		const type = event.type();
		console.log('got event of type: ' + type);
		if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
			return Clutter.EVENT_PROPAGATE;
		const key = event.get_key_symbol();
		console.log('Got a key: ' + key);
		if (key !== Clutter.KEY_Shift_L && key !== Clutter.KEY_Shift_R)
			return Clutter.EVENT_PROPAGATE;

		this._shiftChanged(type === Clutter.EventType.KEY_PRESS);
		return Clutter.EVENT_PROPAGATE;
	}

	_gestureBegin(_time: number, _unused: string, _x_in: number, _y_in: number, dx_in: number, _dy_in: number): void {
		//log('gesture begin: ' + dx_in + ', ' + dy_in);
		const getMagicRow = (window: Window): number => {
			const offsets = {
				'google-chrome': [8, 8],  // maximized, non-maximized offset from top
				'firefox': [7, 7],
				'gnome-terminal-server': [52, 52],
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

		const getStartPosition = (pixbuf: GdkPixbuf.Pixbuf, row: number, _window: Window, movingRight: boolean): number => {
			// const candidateToStr = (candidate: number[]): string => {
			// 	return 'val: ' + candidate[0] + ', [' + candidate[1] + ', ' + candidate[2] + ']';
			// };
			// Pixels to exclude on left/right of an app
			// const exclude = {
			// 	'google-chrome': [0, 100],
			// };
			// Idea: get center of contiguous block of pixels, at least of size 5, that's closest to 0 or 1
			// Assume third pixel from left if background color. look for brightest that's not background
			const pixels = pixbuf.get_pixels().slice(
				pixbuf.get_rowstride() * row,
				pixbuf.get_rowstride() * row + 4 * pixbuf.width,
			).reduce((out: number[], val: number, idx: number) => {
				switch (idx % 4) {
					case 0: out.push(val); break;
					case 1: out[out.length - 1] += val; break;
					case 2: out[out.length - 1] += val;
						out[out.length - 1] /= (3 * 255); break;
					case 3: // alpha, skip.
						break;
				}
				return out;
			}, []);
			if (pixels.length < 3) {
				return 0;
			}
			const bg = pixels[2];
			//log('bg: ' + bg);
			const group = pixels.reduce((accum: number[][], current: number, index: number): number[][] => {
				if (accum.length === 0 || accum[accum.length - 1][0] !== current) {
					accum.push([current, index, index]);
				} else {
					accum[accum.length - 1][2] = index;
				}
				return accum;
			}, []).filter(elt => {
				return Math.abs(elt[0] - bg) > 0.01 && (elt[2] - elt[1] > 4);
			}).reduce((prev: number[], current: number[]): number[] => {
				// log('prev: ' + candidateToStr(prev));
				// log('curr: ' + candidateToStr(current));
				if (prev[0] > current[0])
					return prev;
				return current;
			});

			const size = group[2] - group[1] + 1;
			let ret = ((group[1] + group[2]) / 2) | 0;
			if (size > 10) {
				ret = movingRight ? group[2] - 1 : group[1] + 1;
			}

			//log('Move cursor to offset ' + ret + ' max: ' + window.maximizedHorizontally);
			return ret;
		};

		const actors = global.get_window_actors();
		const focused_window = global.display.get_focus_window();
		const focused_actors = actors.filter(windowactor => windowactor.meta_window === focused_window);
		if (focused_actors.length !== 1) {
			log('Wrong number of focused windows for tab switch gesture: ' + focused_actors.length);
			return;
		}
		// log('have focused window');
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

		const framerect = focused_window.get_frame_rect();  // The window part, not including shadow
		//framerect.height = Math.min(framerect.height, 32);
		// Mar 05 10:55:23 adlr-work.attlocal.net gnome-shell[67984]: framerect: 242, 5, 1373, 32
		// Mar 05 10:55:23 adlr-work.attlocal.net gnome-shell[67984]: wa: 220, -14, 1417, 1210

		//log('framerect: ' + framerect.x + ', ' + framerect.y + ', ' + framerect.width + ', ' + framerect.height);

		const wa = focused_actors[0];  // Includes full surface with shadows
		//log('wa: ' + wa.x + ', ' + wa.y + ', ' + wa.width + ', ' + wa.height);
		const kMagicRow = getMagicRow(focused_window);
		const rect = new Cairo.RectangleInt({  // What we'll get a screenshot of
			x: framerect.x - wa.x,
			y: framerect.y - wa.y,
			width: framerect.width,
			height: Math.min(framerect.height, 101),
		});
		//log('rect: ' + rect.x + ', ' + rect.y + ', ' + rect.width + ', ' + rect.height);
		const surface = wa.get_image(rect);

		if (surface === null) {
			log('no surface!');
			return;
		}
		const pixbuf = pixbuf_get_from_surface(surface, 0, 0, rect.width, rect.height);
		if (pixbuf === null) {
			log('no pixbuf!');
			return;
		}
		// got the pixbuf!
		if (pixbuf.get_colorspace() !== GdkPixbuf.Colorspace.RGB || pixbuf.get_bits_per_sample() !== 8 || pixbuf.get_n_channels() !== 4) {
			log('Unable to handle pixbuf with colorspace:' + pixbuf.get_colorspace() + ', bps:' + pixbuf.get_bits_per_sample() + ', hasAlpha:' +
				pixbuf.get_has_alpha() + ', channels:' + pixbuf.get_n_channels());
			return;
		}
		// log('colorspace:' + pixbuf.get_colorspace() + ', bps:' + pixbuf.get_bits_per_sample() + ', hasAlpha:' +
		// 	pixbuf.get_has_alpha() + ', channels:' + pixbuf.get_n_channels());
		// const bytes = pixbuf.get_pixels();
		// const bwvals = [];
		// for (let i = 0; i < rect.width; i++) {
		// 	const boff = i*4;
		// 	bwvals.push((bytes[boff] + bytes[boff + 1] + bytes[boff + 2]) / (255 * 3));
		// }

		// const file = File.new_for_path('/tmp/data.png');
		// const outstream = file.create(FileCreateFlags.NONE, null);
		// pixbuf.save_to_streamv(outstream, 'png', null, null, null);

		// Get mouse position
		const [mouse_x, mouse_y, _] = global.get_pointer();
		// log('mouse is at ' + mouse_x + ', ' + mouse_y);
		this._originalCursorPos = [mouse_x, mouse_y];
		//const seat = Clutter.get_default_backend().get_default_seat();
		//seat.warp_pointer(framerect.x + getStartPosition(pixbuf, kMagicRow, focused_window), framerect.y + kMagicRow);
		const new_x = framerect.x + getStartPosition(pixbuf, kMagicRow, focused_window, dx_in > 0);
		const new_y = framerect.y + kMagicRow;
		// log('warping cursor to ' + new_x + ', ' + new_y);
		this._virtualPointer.notify_absolute_motion(Clutter.CURRENT_TIME, new_x, new_y);
		this._bounds = getBounds(focused_window, pixbuf);
		this._lastNewX = new_x;

		// const [out_mouse_x, out_mouse_y, __] = global.get_pointer();
		// log('mouse is at ' + out_mouse_x + ', ' + out_mouse_y);

		// Start capturing for shift key
		// this._shiftCapture = global.stage.connect('captured-event', (_stage : Clutter.Actor, event : Clutter.Event) => {
		// 	const type = event.type();
		// 	console.log('got event of type: ' + type);
		// 	if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
		// 		return Clutter.EVENT_PROPAGATE;
		// 	const key = event.get_key_symbol();
		// 	console.log('Got a key: ' + key);
		// 	if (key !== Clutter.KEY_Shift_L && key !== Clutter.KEY_Shift_R)
		// 		return Clutter.EVENT_PROPAGATE;

		// 	this._shiftChanged(type === Clutter.EventType.KEY_PRESS);
		// 	return Clutter.EVENT_PROPAGATE;
		// });
		this._shiftCapture = global.stage.connect('key-press-event', this._onKeyEvent.bind(this));
		this._shiftCapture2 = global.stage.connect('key-release-event', this._onKeyEvent.bind(this));
		console.log(`shift capture: ${this._shiftCapture}, ${this._shiftCapture2}`);


		// const tex = wa.get_texture();
		// const itex = tex.get_texture();
		// const buf_width = itex.get_width();
		// const buf_height = itex.get_height();
		// const buf = new Uint8Array(buf_width * buf_height * 4);
		// const gdres = itex.get_data(/*PixelFormat.RGBA_8888*/ 83, 0, buf);
		// log('got data with size ' + buf_width + ' x ' + buf_height + ' with result: ' + gdres);
	}

	_gestureUpdate(_gesture: never, _time: never, delta: number, _distance: number): void {
		if (this._originalCursorPos === null || this._bounds === null) {
			return;
		}

		//log('gesture update: ' + distance + ', ' + delta);
		const [_mouse_x, mouse_y, _] = global.get_pointer();
		//log('mouse is at ' + mouse_x + ', ' + mouse_y);
		this._lastNewX = Math.max(this._bounds[0], Math.min(this._bounds[1], this._lastNewX + delta));
		this._virtualPointer.notify_absolute_motion(Clutter.CURRENT_TIME, Math.round(this._lastNewX), mouse_y);
	}

	_shiftChanged(down: boolean): void {
		if (down) {
			this._skipFinalClick = true;
			this._virtualPointer.notify_button(Clutter.CURRENT_TIME, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
		} else {
			this._virtualPointer.notify_button(Clutter.CURRENT_TIME, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
		}
	}

	_gestureEnd(): void {
		if (this._originalCursorPos === null)
			return;
		//log('gesture end');
		// Do a click
		if (!this._skipFinalClick) {
			this._virtualPointer.notify_button(Clutter.CURRENT_TIME, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
			this._virtualPointer.notify_button(Clutter.CURRENT_TIME, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
			this._virtualPointer.notify_absolute_motion(Clutter.CURRENT_TIME, this._originalCursorPos[0], this._originalCursorPos[1]);
		}
		this._reset();
	}

	private _reset() {
		this._originalCursorPos = null;	
		this._bounds = null;
		if (this._shiftCapture) {
			global.stage.disconnect(this._shiftCapture);
			this._shiftCapture = 0;
		}
		if (this._shiftCapture2) {
			global.stage.disconnect(this._shiftCapture2);
			this._shiftCapture2 = 0;
		}
		this._skipFinalClick = false;
	}
}