//
// int64/uint64 support is limited in javascript.  Each struct can specify
// a strategy for handling 64-bit values that occur in the data definition
// by passing the int64mode option.
//
// strict: Create a js 'number'; throw Error if the 64-bit number doesn't fit
// lossy: Create a js 'number'; use Infinity or -Infinity if it doesn't fit
// copy: Read 64-bit number into an 8-byte buffer
// slice: Return an 8-byte "slice" of the original buffer
// int64: Return an int64 implementation, currently set to bignumber.js package
// skip: Ignore 64-bit fields altogether
//
var int64modes = exports.int64modes = {
	strict: 'strict',
	lossy:  'lossy',
	copy:   'copy',
	slice:  'slice',
	int64:  'int64',
	skip:   'skip'
};

var BigNumber = null;

function validateInt64Mode(int64mode) {
	if (int64mode in int64modes) {
		if (int64mode === int64modes.int64 && BigNumber == null) {
			BigNumber = require('bignumber.js');
		}
	}
	else {
		throw new Error('Unsupported int64mode: ' + int64mode);
	}
}

//
// Create a struct def
//
function StructDef(opts) {
	this.name = opts && opts.name;
	this.fields = [];
	this.staticSized = true;
	this.size = 0;
	this.littleEndian = !!(opts && opts.littleEndian);
	this.noAssert = !!(opts && opts.noAssert);
	if(opts && 'int64mode' in opts) {
		validateInt64Mode(opts.int64mode);
		this.int64mode = opts.int64mode;
	} else {
		this.int64mode = int64modes.strict;
	}
	this.Wrapper = function BufferWrapper(buf) {
		Object.defineProperty(this, '_buffer', {value:buf});
	};
	Object.defineProperty(this.Wrapper.prototype,
		'_def', {value:this,writable:false});
	Object.defineProperty(this.Wrapper.prototype,
		'_fields', {get:function() { return this._def.fields; }});

	// Check if each field equals its default value
	this.Wrapper.prototype.checkValues = function() {
		var wrapper = this;
		var assert = require('assert');
		this._fields.forEach(function(f) {
			if('value' in f) {
				assert.equal(wrapper[f.name], f.value, f.name);
			}
		});
		return this;
	};

	// Write default values into the fields
	this.Wrapper.prototype.writeValues = function() {
		var wrapper = this;
		this._fields.forEach(function(f) {
			if('value' in f) {
				wrapper[f.name] = f.value;
			}
		});
		return this;
	};
}

StructDef.prototype.field = function defineField(f, struct) {
	if (this.fields.find(function(field) {
			return field.name === f.name;
		}) == undefined) {
		f.offset = this.size;
		this.size += f.size;
		this.fields.push(f);
	}

	var desc = {
		enumerable: true,
		configurable: f.hasOwnProperty("sizeFieldName")
	};

	if(f.read) {
		desc.get = function() {
			return f.read.apply(this._buffer, [f.offset, this.noAssert, this, f]);
		};
	}

	if(f.write) {
		desc.set = function(value) {
			return f.write.apply(this._buffer, [value, f.offset, this.noAssert, this, f]);
		};
	}

	Object.defineProperty(this.Wrapper.prototype, f.name, desc);
	Object.defineProperty(this, f.name, { value: f, configurable: f.hasOwnProperty("sizeFieldName")});

	return this;
};

function createBufferReader(size) {
	var reader;
	reader = function readbuffer(offset, noAssert, def, field) {
		// "this" should be a Buffer
		if(!Buffer.isBuffer(this)) throw new Error('Should be applied to a buffer!');
		if(!noAssert && offset + size > this.length) {
			throw new Error('Field runs beyond the length of the buffer.');
		}
		return this.slice(offset, offset + size);
	};
	return reader;
}

function createBufferWriter(size) {
	var writer = function writebuffer(val, offset, noAssert) {
		// "this" is a Buffer
		if(Buffer.isBuffer(val)) {
			if(val.length != size) {
				throw new Error('Buffer used as string field must be' + size + ' bytes long!');
			}
			val.copy(this, offset);
		}
	};
	return writer;
}

function createStringReader(size) {
	var reader;
	reader = function readString(offset, noAssert, def, field) {
		// "this" should be a Buffer
		if(!Buffer.isBuffer(this)) throw new Error('Should be applied to a buffer!');
		if(!noAssert && offset + size > this.length) {
			throw new Error('Field runs beyond the length of the buffer.');
		}
		return this.toString('utf8', offset, offset + size);
	};
	return reader;
}

function createStringWriter(size) {
	var writer = function writeString(val, offset, noAssert) {
		// "this" is a Buffer
		if(typeof(val) === 'string') {
			this.fill(0, offset, offset + size);
			this.write(val, offset);
		} else if(Buffer.isBuffer(val)) {
			if(val.length != size) {
				throw new Error('Buffer used as string field must be' + size + ' bytes long!');
			}
			val.copy(this, offset);
		}
	};
	return writer;
}

function createInt64Reader(signed, littleEndian) {
	var reader;
	reader = function readInt64AsNumber(offset, noAssert, def, field) {
		// "this" should be a Buffer
		if(!Buffer.isBuffer(this)) throw new Error('Should be applied to a buffer!');
		if(!noAssert && offset + 8 > this.length) {
			throw new Error('Field runs beyond the length of the buffer.');
		}
		var int64mode = field.int64mode || def.int64mode || int64modes.strict;
		validateInt64Mode(int64mode);

		switch (int64mode) {
			case int64modes.int64:
			case int64modes.lossy:
			case int64modes.strict:
				var hi, lo;

				if(littleEndian) {
					hi = this.readUInt32LE(offset+4, noAssert);
					lo = this.readUInt32LE(offset+0, noAssert);
				} else {
					hi = this.readUInt32BE(offset+0, noAssert);
					lo = this.readUInt32BE(offset+4, noAssert);
				}

				if (int64mode === int64modes.int64) {
					return new BigNumber(lo).plus(new BigNumber(hi).times(0x100000000));
				}

				// Does it fit in a the 53-bits supported by javascript numbers?
				// hi contains the upper 32 bits, only 21 of which can be used,
				// or 20 for unsigned numbers.
				var lostBits = hi & 0xFFF00000;
				// If the lost bits are all zero we're OK
				// Also for a signed negative number the lost bits can be all
				// one and we're OK
				if(lostBits !== 0 && (!signed || lostBits !== 0xFFF00000)) {
					// If the mode is "strict" then verify we don't lose any bits when
					// we truncate the number to fit into a floating point number.
					if(int64mode === int64modes.strict) {
						// Data will be lost ... !
						throw new Error('64-bit number too large for javascript number data type; bytes: '+this.toString('hex', offset, offset+8)+(littleEndian?' (little endian)':' (big endian)'));
					} else {
						if(!signed || (hi & 0x80000000) == 0) {
							return Infinity;
						} else {
							return -Infinity;
						}
					}
				}

				// TODO CHECK IF THIS IS OK, shifting 32 bits to left???
				return ((hi & 0x001FFFFF) << 32) | lo & 0xFFFFFFFF;
			case int64modes.slice:
				return this.slice(offset, offset+8);
			case int64modes.copy:
				var result = new Buffer(8);
				this.copy(result, 0, offset, offset + 8);
				return result;
		}
	};

	return reader;
};

function createInt64Writer(signed, littleEndian) {
	var writer = function writeInt64(val, offset, noAssert) {
		// "this" is a Buffer

		if ((BigNumber != null && val instanceof BigNumber) || typeof(val) === 'number') {
			var hi, lo;

			if (val instanceof BigNumber) {
				var zeroInt64Binary = '0000000000000000000000000000000000000000000000000000000000000000';
				var valAsBinary = (zeroInt64Binary + val.toString(2)).slice(-64);

				hi = parseInt(valAsBinary.substring(0, 32), 2);
				lo = parseInt(valAsBinary.substring(32), 2);

			} else {
				// TODO CHECK IF THIS IS OK, shifting 32 bits to right???
				hi = val >> 32;
				lo = val & 0xFFFFFFFF;
			}

			if(littleEndian) {
				this.writeUInt32LE(hi, offset+4, noAssert);
				this.writeUInt32LE(lo, offset+0, noAssert);
			}
			else {
				this.writeUInt32BE(hi, offset+0, noAssert);
				this.writeUInt32BE(lo, offset+4, noAssert);
			}

		} else if(Buffer.isBuffer(val)) {
			if(val.length != 8) {
				throw new Error('Buffer used as int64 field must be 8 bytes long!');
			}
			val.copy(this, offset);
		}
	};
	return writer;
};

function setupDefiners() {
	function defNumberTypeDefaultEndian(nameNoEndian) {
		// Add one without the le/be suffix that uses the
		// default endian.  Both le and be definers should
		// be set up when this is called.
		var beDefiner = StructDef.prototype[nameNoEndian + 'be'];
		var leDefiner = StructDef.prototype[nameNoEndian + 'le'];
		StructDef.prototype[nameNoEndian] = function defineIntFieldDefaultEndian() {
			var args = Array.prototype.slice.call(arguments);
			var fn = this.littleEndian?leDefiner:beDefiner;
			fn.apply(this, args);
			return this;
		};
	}

	function defBufferType() {
		var lowerCaseTypeName = 'buffer';
		var definer = function defineBufferField() {
			var f = {
				type: lowerCaseTypeName,
				name: arguments[0],
				size: 0,
				read: undefined,
				write: undefined
			};
			if (Buffer.isBuffer(arguments[1])) {
				f.value = arguments[1];
				f.size = arguments[1].length;
				f.read = createBufferReader(f.size);
				f.write = createBufferWriter(f.size);
			} else if (typeof(arguments[1]) === 'number') {
				f.size = arguments[1];
				f.read = createBufferReader(f.size);
				f.write = createBufferWriter(f.size);
			} else if (typeof(arguments[1]) === 'object') {
				for (var p in arguments[1]) {
					f[p] = arguments[1][p];
				}
				f.read = createBufferReader(f.size);
				f.write = createBufferWriter(f.size);
			} else {
				throw new Error('Unexpected argument ' + arguments[1] + ' with type ' + typeof(arguments[1]));
			}
			this.field(f);
			return this;
		};
		StructDef.prototype[lowerCaseTypeName] = definer;
	}

	function defStringType() {
		var lowerCaseTypeName = 'string';
		var definer = function defineStringField() {
			var f = {
				type: lowerCaseTypeName,
				name: arguments[0],
				size: 0,
				read: undefined,
				write: undefined
			};
			if (Buffer.isBuffer(arguments[1])) {
				f.value = arguments[1];
				f.size = arguments[1].length;
				f.read = createStringReader(f.size);
				f.write = createStringWriter(f.size);
			} else if (typeof(arguments[1]) === 'string') {
				var sizeIndicatorFieldName = arguments[1];
				var sizeIndicatorField = this.fields.find(function(field) {
					return field.name === sizeIndicatorFieldName;
				});

				if (sizeIndicatorField == undefined) {
					// the passed second arg is the value of the field itself
					f.value = new Buffer(arguments[1]);
					f.size = arguments[1].length;
					f.read = createStringReader(f.size);
					f.write = createStringWriter(f.size);
				}
				else {
					f.sizeFieldName = sizeIndicatorField.name;
					this.staticSized = false;
				}
			} else if (typeof(arguments[1]) === 'number') {
				f.size = arguments[1];
				f.read = createStringReader(f.size);
				f.write = createStringWriter(f.size);
			} else if (typeof(arguments[1]) === 'object') {
				for (var p in arguments[1]) {
					f[p] = arguments[1][p];
				}
				f.read = createStringReader(f.size);
				f.write = createStringWriter(f.size);
			} else {
				throw new Error('Unexpected argument ' + arguments[1] + ' with type ' + typeof(arguments[1]));
			}
			this.field(f);
			return this;
		};
		StructDef.prototype[lowerCaseTypeName] = definer;
	}

	function defNumberType(upperCaseTypeName, size, reader, writer) {
		var readImpl = reader || Buffer.prototype['read'+upperCaseTypeName];
		var writeImpl = writer || Buffer.prototype['write'+upperCaseTypeName];
		var lowerCaseTypeName = upperCaseTypeName.toLowerCase();
		var definer = function defineIntField() {
			var f = {
				type:lowerCaseTypeName,
				name:this.fields.length,
				size:size,
				read:readImpl,
				write:writeImpl
			};
			for(var i=0; i < arguments.length; i++) {
				var arg = arguments[i];
				if(!arg) {
					// Ignore null, false, etc I guess ...
				} else if(Buffer.isBuffer(arg) || typeof(arg) === 'number') {
					f.value = arg;
				} else if(typeof(arg) === 'string') {
					f.name = arg;
				} else if(typeof(arg) === 'object') {
					Object.keys(arg).forEach(function(k) {
						f[k] = arg[k];
					});
				} else {
					throw new Error('Unexpected argument '+arg);
				}
			}
			this.field(f);
			return this;
		};
		StructDef.prototype[lowerCaseTypeName] = definer;
		if(lowerCaseTypeName === 'uint8')
			StructDef.prototype.byte = definer;
	}

	var intBits = [8, 16, 32, 64];
	for(var i=0; i < 16; i++) {
		var bits = intBits[(i>>2) % 4];
		var signed = (i & 1) === 1;
		var littleEndian = (i & 2) === 2;
		if(littleEndian && bits === 8)
			continue; // No endian-ness on single bytes
		var upperCaseTypeName = (signed?"":"U")+"Int"+bits+(bits === 8?"":littleEndian?"LE":"BE");
		var reader = null;
		var writer = null;
		if(bits == 64) {
			reader = createInt64Reader(signed, littleEndian);
			writer = createInt64Writer(signed, littleEndian);
		}
		defNumberType(upperCaseTypeName, bits >> 3, reader, writer);

		// If we've now done both little and big endian, add the
		// method that has no be/le suffix and uses the default
		// endian-ness for this structure.
		if(littleEndian) {
			defNumberTypeDefaultEndian(upperCaseTypeName.slice(0, upperCaseTypeName.length-2).toLowerCase());
		}
	}

	// Add float and double
	for(var i=0; i < 4; i++) {
		var littleEndian = (i & 1) === 1;
		var double = (i >> 1) & 1 === 1;
		var name = double ? "Double" : "Float";
		var bits = double ? 64 : 32;
		var upperCaseTypeName = name+(littleEndian?"LE":"BE");
		defNumberType(upperCaseTypeName, bits >> 3);
		if(littleEndian) {
			defNumberTypeDefaultEndian(name.toLowerCase());
		}
	}

	// Add string
	defStringType();

	// Add buffer
	defBufferType();
}

setupDefiners();

StructDef.prototype.checkSize = function(expectedSize) {
	if(expectedSize !== this.size) {
		require('assert').fail(this.size, this.expectedSize, 'Wrong size', '!==');
	}
	return this;
};

StructDef.prototype.wrap = function wrapBuf(buf) {
	return new (this.Wrapper)(buf);
};

StructDef.prototype.unpack = StructDef.prototype.read = function readFieldsFromBuf(buf, targetObjectCtor, offset, noAssert) {
	var data = {};

	if(noAssert == null) {
		noAssert = this.noAssert;
	}

	if(offset == null) {
		offset = 0;
	}

	this.fields.forEach(function readField(f) {
		if (f.sizeFieldName) {
			this.size += data[f.sizeFieldName] - f.size;
			f.size = data[f.sizeFieldName];
			f.read = createStringReader(f.size);
			f.write = createStringWriter(f.size);

			this.field(f);
		}

		var readImpl = f.read;
		if(readImpl) {
			var fieldValue = readImpl.apply(buf, [offset + f.offset, noAssert, this, f]);

			if (typeof(f.name) !== 'number') {
				// skip default filler fields, whose name is integer 1, 2, ...
				data[f.name] = fieldValue;
			}
		}
	}, this);

	if(targetObjectCtor == null) {
		return data;
	}

	var newTargetObj = Object.create(targetObjectCtor.prototype);
	targetObjectCtor.apply(newTargetObj, Object.keys(data).map(function(key){ return data[key]; }));

	return newTargetObj;
};

StructDef.prototype.pack = StructDef.prototype.write = function writeFieldsIntoBuf(data, buf, offset, noAssert) {
	if(data == null) {
		data = {}; // Write all zeroes and defaults
	}

	if (!this.staticSized) {
		var variableSizedField = this.fields.find(function(field) {
			return field.sizeFieldName != undefined;
		});

		var sizeIndicatiorField = this.fields.find(function(field) {
			return field.name === variableSizedField.sizeFieldName;
		});

		var sizeIndicatiorFieldValue = (sizeIndicatiorField.name in data ? data[sizeIndicatiorField.name] : sizeIndicatiorField.value) || 0;

		this.size += sizeIndicatiorFieldValue - variableSizedField.size;
		variableSizedField.size = sizeIndicatiorFieldValue;
		variableSizedField.read = createStringReader(variableSizedField.size);
		variableSizedField.write = createStringWriter(variableSizedField.size);

		this.field(variableSizedField);
	}

	if(noAssert == null) {
		noAssert = this.noAssert;
	}

	if(offset == null) {
		offset = 0;
	}

	if(buf == null) {
		buf = new Buffer(this.size + offset);
	}

	this.fields.forEach(function writeField(f) {
		var writeImpl = f.write;

		if(writeImpl) {
			var value = (f.name in data ? data[f.name] : f.value) || 0;
			writeImpl.apply(buf, [value, offset + f.offset, noAssert]);
		}
	});
	return buf;
};

exports.def = function createNewStructDef(opts) {
	return new StructDef(opts);
};

// polyfill for array.find
if (!Array.prototype.find) {
	Array.prototype.find = function(predicate) {
		if (this === null) {
			throw new TypeError('Array.prototype.find called on null or undefined');
		}
		if (typeof predicate !== 'function') {
			throw new TypeError('predicate must be a function');
		}
		var list = Object(this);
		var length = list.length >>> 0;
		var thisArg = arguments[1];
		var value;

		for (var i = 0; i < length; i++) {
			value = list[i];
			if (predicate.call(thisArg, value, i, list)) {
				return value;
			}
		}
		return undefined;
	};
}