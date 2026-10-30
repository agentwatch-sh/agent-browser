"""Merge the monitor log and the command marks: which command changed the frontmost app or the pointer?"""
import json, sys

d = sys.argv[1]
chrome_pid = int(sys.argv[2]) if len(sys.argv) > 2 else None
events = [json.loads(l) for l in open(f"{d}/monitor.jsonl") if l.startswith("{")]
marks = [json.loads(l) for l in open(f"{d}/marks.jsonl") if l.strip()]
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
        continue
    if "front" in x:
        tag = "  <== THE AGENT CHROME" if chrome_pid and x["front"] == chrome_pid else ""
        print(f"{t:.2f}  FRONT -> {x['name']} (pid {x['front']}) during: {current}{tag}")
    else:
        print(f"{t:.2f}  pointer {x['pointer']} during: {current}")
