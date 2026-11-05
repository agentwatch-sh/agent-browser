"""A peer-credential helper in Python (board ab-v16.47 probe): the pid, uid and gid of the peer of the
connected Unix socket on fd 3."""
import socket, struct, sys
s = socket.socket(fileno=3)
pid, uid, gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
s.detach()
sys.stdout.write(f"{pid} {uid} {gid}\n")
