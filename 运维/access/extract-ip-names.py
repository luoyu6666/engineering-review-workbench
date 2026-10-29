# -*- coding: utf-8 -*-
"""
把《工程咨询事业部IP和MAC地址》表格读成 JSON，并与系统账号比对。

输出落成文件而非直接打印：Windows 控制台使用 GBK 代码页，中文 print 会乱码（经实测），
因此统一写文件，再用编辑器或读取工具查看。
"""
import json
import os
import sys

import openpyxl

sys.stdout.reconfigure(encoding="utf-8")

XLSX = r"C:\Users\Administrator\Desktop\工程咨询事业部IP和MAC地址20260928.xlsx"
ROOT = r"D:\Deepseek harness工作区\生活其他\审核工作台"
OUT = os.path.join(ROOT, "运维", "access", "ip-names.json")
USERS = os.path.join(ROOT, "web", "data", "users.json")

wb = openpyxl.load_workbook(XLSX, data_only=True)
ws = wb.worksheets[0]
rows = []
for r in ws.iter_rows(min_row=2, values_only=True):
    if not r or all(c is None or str(c).strip() == "" for c in r):
        continue
    seq, name, ip, mac = (list(r) + [None, None, None, None])[:4]
    rows.append({
        "seq": str(seq).strip() if seq is not None else "",
        "name": str(name).strip() if name is not None else "",
        "ip": str(ip).strip() if ip is not None else "",
        "mac": str(mac).strip() if mac is not None else "",
    })

users = []
if os.path.exists(USERS):
    users = json.load(open(USERS, encoding="utf-8"))

sys_names = {u.get("name", "").strip(): u for u in users}
matched, unmatched, empty_ip = [], [], []
for r in rows:
    u = sys_names.get(r["name"])
    item = dict(r)
    item["account"] = (u or {}).get("username", "")
    item["role"] = (u or {}).get("role", "")
    if not r["ip"]:
        empty_ip.append(item)
    elif u:
        matched.append(item)
    else:
        unmatched.append(item)

accounts_without_ip = [u.get("name", "") for u in users
                       if u.get("name", "").strip() not in {r["name"] for r in rows if r["ip"]}]

out = {
    "source": XLSX,
    "rows": rows,
    "systemUsers": [{"name": u.get("name"), "username": u.get("username"), "role": u.get("role"),
                     "disabled": bool(u.get("disabled"))} for u in users],
    "matched": matched,
    "unmatchedName": unmatched,
    "emptyIp": empty_ip,
    "accountsWithoutIp": accounts_without_ip,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("已写出：", OUT)
print("表格数据行 %d（其中有 IP %d、无 IP %d）" % (len(rows), len(rows) - len(empty_ip), len(empty_ip)))
print("与系统账号匹配 %d、名字对不上 %d、系统里有但名单没给 IP %d"
      % (len(matched), len(unmatched), len(accounts_without_ip)))
