/* A peer-credential helper (board ab-v16.47 probe): prints the pid, uid and gid of the peer of the
 * connected Unix socket on fd 3. Build: cc -O2 -o <scratch>/peercred peercred.c */
#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
int main(void) {
  struct ucred c; socklen_t n = sizeof c;
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &c, &n) != 0) { perror("getsockopt"); return 1; }
  printf("%d %d %d\n", c.pid, c.uid, c.gid);
  return 0;
}
