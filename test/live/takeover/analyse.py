"""Merge the monitor log and the command marks: which command or start changed the frontmost app or the pointer?

  python3 -I analyse.py DIR [CHROME_PID ...]    (each agent Chrome pid, for example one per start)
"""
import json, sys


def jsonl(path):
    """The JSON lines of a file; a bad last line (a kill can cut it) is skipped, another bad line is named."""
    lines = open(path).read().split("\n")
    out = []
    for i, line in enumerate(lines):
        if not line.startswith("{"):
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            if i < len(lines) - 1:
                print(f"BAD LINE {i + 1} of {path}: {line[:120]}")
    return out


d = sys.argv[1]
chrome_pids = {int(p) for p in sys.argv[2:]}
events = jsonl(f"{d}/monitor.jsonl")
marks = jsonl(f"{d}/marks.jsonl")
timeline = sorted([(m["t"], "mark", m) for m in marks] + [(e["t"], "mon", e) for e in events], key=lambda x: x[0])
current = "(before the check)"
for t, kind, x in timeline:
    if kind == "mark":
        if x["what"].startswith("start "):
            current = x["what"][6:]
        elif x["what"].startswith(("end ", "fail ")):
            print(f"{t:.2f}  {x['what']}  {json.dumps(x.get('detail'))[:120]}")
            current = f"(after {x['what'][4:] if x['what'].startswith('end ') else x['what'][5:]})"
        elif x["what"] == "log":
            print(f"{t:.2f}  log: {x.get('detail')}")
        elif x["what"] == "liveness":
            print(f"{t:.2f}  liveness: {x.get('detail')}")
        continue
    if "front" in x:
        tag = "  <== AN AGENT CHROME" if x["front"] in chrome_pids else ""
        print(f"{t:.2f}  FRONT -> {x['name']} (pid {x['front']}) during: {current}{tag}")
    elif "launched" in x:
        print(f"{t:.2f}  launched {x['name']} (pid {x['launched']}) during: {current}")
    elif "pointer" in x:
        print(f"{t:.2f}  pointer {x['pointer']} during: {current}")
    # {"alive": true} is the monitor's heartbeat: no change.
