"""Merge the monitor log and the command marks: which command or start changed the frontmost app or the pointer?
With start.ts, the built-in give-back guard's lines (launches-N.log) go into the timeline too, and with
--variant give-back the helper's lines (giveback-N.jsonl).

  python3 -I analyse.py DIR [CHROME_PID ...]    (each agent Chrome pid, for example one per start)
"""
import datetime, glob, json, re, sys


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
helper = [g for path in sorted(glob.glob(f"{glob.escape(d)}/giveback-*.jsonl")) for g in jsonl(path)]


def built_in(path):
    """The built-in give-back guard's lines of a launches-N.log: "<ISO time> give-back <what>"."""
    out = []
    for line in open(path).read().split("\n"):
        m = re.match(r"^(\S+Z) give-back (.+)$", line)
        if m:
            out.append((datetime.datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp(), m.group(2)))
    return out


guard = [g for path in sorted(glob.glob(f"{glob.escape(d)}/launches-*.log")) for g in built_in(path)]
timeline = sorted([(m["t"], "mark", m) for m in marks] + [(e["t"], "mon", e) for e in events] + [(g["t"], "giveback", g) for g in helper]
                  + [(t, "guard", text) for t, text in guard], key=lambda x: x[0])
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
    if kind == "guard":
        print(f"{t:.2f}  built-in give-back: {x} during: {current}")
        continue
    if kind == "giveback":
        if "before" in x:
            print(f"{t:.2f}  give-back helper: in front at its start: {x['name']} (pid {x['before']})")
        elif "took" in x:
            print(f"{t:.2f}  GIVE BACK: {x['name']} (pid {x['took']}) took the front; asked macOS to activate pid {x['gaveBackTo']} (sent: {json.dumps(x['sent'])}) during: {current}")
        continue
    if "front" in x:
        tag = "  <== AN AGENT CHROME" if x["front"] in chrome_pids else ""
        print(f"{t:.2f}  FRONT -> {x['name']} (pid {x['front']}) during: {current}{tag}")
    elif "launched" in x:
        print(f"{t:.2f}  launched {x['name']} (pid {x['launched']}) during: {current}")
    elif "pointer" in x:
        print(f"{t:.2f}  pointer {x['pointer']} during: {current}")
    # {"alive": true} is the monitor's heartbeat: no change.
