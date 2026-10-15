// Names a model file must not take. The loader puts the object's folder first on `sys.path`, so `<name>.py` there
// would be imported in place of the library of that name by anything the model or the worker imports after it is
// loaded. torno's own names are listed by hand; the rest is Python's standard library.

/** What a model imports or the worker does, and torno's own. Compared without regard to case. */
export const SHADOWING_LIBRARIES = ['build123d', 'OCP', 'numpy', 'trimesh', 'PIL', 'ocp_tessellate', 'typing', 'dataclasses', 'math', 'json', 'os', 'sys', 'pathlib', 'functools', 'common', 'torno', 'torno_kernel']

/**
 * `sys.stdlib_module_names` of Python 3.12.11 (the kernel's), without the names that start with an underscore (a
 * name of an object starts with a letter or a digit). Generated once, on 2026-10-15, with
 * `cd kernel && uv run --no-sync python -c "import sys; print(sorted(n for n in sys.stdlib_module_names if not n.startswith('_')))"`
 * and set out in lines; 212 names. 3.11 has a few fewer, 3.13 a few others; a later Python changes this list by hand.
 */
export const STDLIB_MODULES: readonly string[] = [
  'abc', 'aifc', 'antigravity', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'audioop', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code',
  'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib',
  'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal',
  'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl',
  'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass',
  'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib',
  'imghdr', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder',
  'msilib', 'msvcrt', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'nt', 'ntpath', 'nturl2path', 'numbers',
  'opcode', 'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile', 'sre_constants',
  'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'this',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc',
  'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv',
  'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
  'zipfile', 'zipimport', 'zlib', 'zoneinfo'
]
