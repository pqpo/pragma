"""Read kernel per-process disk bytes, not JSON payload or file growth.

macOS ABI: RUSAGE_INFO_V2 in the installed SDK's sys/resource.h and libproc.h.
Linux: /proc/PID/io read_bytes/write_bytes. Unsupported access returns unavailable.
"""
import ctypes
import json
import struct
import sys

try:
    pid = int(sys.argv[1])
    if sys.platform == 'darwin':
        lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        lib.proc_pid_rusage.restype = ctypes.c_int
        buf = ctypes.create_string_buffer(16 + 18 * 8)
        if lib.proc_pid_rusage(pid, 2, ctypes.byref(buf)) != 0:
            raise OSError(ctypes.get_errno(), 'proc_pid_rusage failed')
        read_bytes, write_bytes = struct.unpack_from('=QQ', buf.raw, 16 + 16 * 8)
        source = 'macOS proc_pid_rusage RUSAGE_INFO_V2'
    elif sys.platform.startswith('linux'):
        with open(f'/proc/{pid}/io', encoding='utf8') as stream:
            data = dict(line.strip().split(': ') for line in stream)
        read_bytes, write_bytes = int(data['read_bytes']), int(data['write_bytes'])
        source = 'Linux /proc/PID/io'
    else:
        raise OSError('unsupported platform')
    print(json.dumps(dict(readBytes=read_bytes, writeBytes=write_bytes, source=source)))
except (OSError, ValueError) as error:
    print(json.dumps(dict(unavailable=str(error))))
