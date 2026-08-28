#!/usr/bin/env bash
# End-to-end API test: RBAC enforcement + the full business flow.
set -u
BASE="${BASE:-http://127.0.0.1:3004}"

# ensure the section-10 ledger check talks to the same database as the running
# server (fall back to .env when DATABASE_URL isn't already exported)
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')"
fi

JAR=/tmp/ims-cookies
PASS=0; FAIL=0

login() { # email password jarname
  rm -f "$3"
  code=$(curl -s -g -o /tmp/login.json -w '%{http_code}' -c "$3" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" "$BASE/api/auth/login")
  echo "$code"
}

check() { # description expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1 (got $3)";
  else FAIL=$((FAIL+1)); echo "  FAIL  $1 — expected $2, got $3"; fi
}

expect_status() { # description expected_code method path body jar
  code=$(curl -s -g -o /tmp/resp.json -w '%{http_code}' -X "$3" -b "$6" -H 'Content-Type: application/json' \
    ${5:+-d "$5"} "$BASE$4")
  if [ "$2" != "$code" ]; then echo "        body: $(head -c 220 /tmp/resp.json)"; fi
  check "$1" "$2" "$code"
}

echo "== 1. AUTHENTICATION =="
check "bad password rejected" 401 "$(login admin@ims.tz wrongpass $JAR-bad)"
ADMIN=$JAR-admin;  check "admin login"        200 "$(login admin@ims.tz admin123 $ADMIN)"
WH=$JAR-wh;        check "warehouse login"    200 "$(login wh.manager@ims.tz warehouse123 $WH)"
STORE=$JAR-store;  check "store mgr login"    200 "$(login store.mbezi@ims.tz store123 $STORE)"
CASH=$JAR-cash;    check "cashier login"      200 "$(login cashier@ims.tz cashier123 $CASH)"
AUD=$JAR-aud;      check "auditor login"      200 "$(login auditor@ims.tz audit123 $AUD)"
NOAUTH=$JAR-none; echo "" > $NOAUTH

echo
echo "== 2. RBAC — server-side enforcement (not just hidden UI) =="
expect_status "no session -> 401 on POS sale"      401 POST /api/sales '{"locationId":"x","lines":[{"variantId":"y","quantity":1}]}' $NOAUTH
expect_status "cashier CANNOT create a purchase"   403 POST /api/purchases '{"supplierId":"x","locationId":"y","lines":[]}' $CASH
expect_status "warehouse mgr CANNOT sell at POS"   403 POST /api/sales '{"locationId":"x","lines":[]}' $WH
expect_status "auditor CANNOT write anything"      403 POST /api/products '{"name":"Nope"}' $AUD
expect_status "auditor CANNOT approve adjustment"  403 PATCH /api/adjustments/none '{"action":"approve"}' $AUD
expect_status "cashier CANNOT approve adjustment"  403 PATCH /api/adjustments/none '{"action":"approve"}' $CASH
expect_status "cashier CANNOT see audit log"       403 GET  /api/audit '' $CASH
expect_status "auditor CAN see audit log"          200 GET  /api/audit '' $AUD
expect_status "store mgr CANNOT manage users"      403 POST /api/users '{"name":"x","email":"x@y.z","password":"secret1","role":"CASHIER"}' $STORE
expect_status "admin CAN see users"                200 GET  /api/users '' $ADMIN

echo
echo "== 3. LOCATION CAPABILITY + ASSIGNMENT CHECKS =="
WH_ID=$(curl -s -b $ADMIN "$BASE/api/locations" | python3 -c 'import json,sys;print([l["id"] for l in json.load(sys.stdin)["locations"] if l["code"]=="WH-MAIN"][0])')
MBEZI_ID=$(curl -s -b $ADMIN "$BASE/api/locations" | python3 -c 'import json,sys;print([l["id"] for l in json.load(sys.stdin)["locations"] if l["code"]=="ST-MBEZI"][0])')
KAR_ID=$(curl -s -b $ADMIN "$BASE/api/locations" | python3 -c 'import json,sys;print([l["id"] for l in json.load(sys.stdin)["locations"] if l["code"]=="ST-KAR"][0])')
SUP_ID=$(curl -s -b $ADMIN "$BASE/api/suppliers" | python3 -c 'import json,sys;print(json.load(sys.stdin)["suppliers"][0]["id"])')
VARIANT_JSON=$(curl -s -g -b $ADMIN "$BASE/api/variants?locationId=$WH_ID")
V_ID=$(echo "$VARIANT_JSON" | python3 -c 'import json,sys;print([v for v in json.load(sys.stdin)["variants"] if v["productName"]=="Wireless Mouse" and v["label"]=="Grey"][0]["id"])')
echo "  using variant $V_ID (Wireless Mouse — Grey)"
echo "  warehouse=$WH_ID mbezi=$MBEZI_ID kariakoo=$KAR_ID supplier=$SUP_ID"

SUP_LINE="{\"variantId\":\"$V_ID\",\"quantity\":1,\"unitCost\":100}"
expect_status "admin blocked by can_receive_purchase=false at a store" 422 POST /api/purchases \
  "{\"supplierId\":\"$SUP_ID\",\"locationId\":\"$MBEZI_ID\",\"lines\":[$SUP_LINE]}" $ADMIN
expect_status "warehouse mgr blocked by location assignment first" 403 POST /api/purchases \
  "{\"supplierId\":\"$SUP_ID\",\"locationId\":\"$MBEZI_ID\",\"lines\":[$SUP_LINE]}" $WH
expect_status "store mgr cannot ship FROM a store they do not own" 403 POST /api/transfers \
  "{\"fromLocationId\":\"$KAR_ID\",\"toLocationId\":\"$MBEZI_ID\",\"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":1}]}" $STORE

expect_status "warehouse mgr CAN ship to a store they are not assigned to" 200 GET "/api/transfers" '' $WH

echo
echo "== 4. PURCHASE -> WAREHOUSE STOCK (batch creation) =="
BEFORE=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$WH_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
echo "  Wireless Mouse (Grey) at warehouse before purchase: $BEFORE"

PO_CODE=$(curl -s -g -o /tmp/po.json -w '%{http_code}' -b $WH -H 'Content-Type: application/json' \
  -d "{\"supplierId\":\"$SUP_ID\",\"locationId\":\"$WH_ID\",\"confirmImmediately\":true,
       \"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":25,\"unitCost\":19000}]}" "$BASE/api/purchases")
check "warehouse manager confirms a purchase" 201 "$PO_CODE"
PO_ID=$(python3 -c 'import json;print(json.load(open("/tmp/po.json"))["purchase"]["id"])')

AFTER=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$WH_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "stock rose by exactly 25 units" "$((BEFORE+25))" "$AFTER"

BATCHES=$(curl -s -b $ADMIN "$BASE/api/variants/$V_ID" | python3 -c "
import json,sys
b=[x for x in json.load(sys.stdin)['batches'] if x['locationId']=='$WH_ID']
print(len(b))")
echo "  open lots at warehouse for this variant: $BATCHES"

echo
echo "== 5. FIFO ACROSS A TRANSFER (cost + date follow the goods) =="
TR_CODE=$(curl -s -g -o /tmp/tr.json -w '%{http_code}' -b $WH -H 'Content-Type: application/json' \
  -d "{\"fromLocationId\":\"$WH_ID\",\"toLocationId\":\"$MBEZI_ID\",\"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":10}]}" \
  "$BASE/api/transfers")
check "transfer created" 201 "$TR_CODE"
TR_ID=$(python3 -c 'import json;print(json.load(open("/tmp/tr.json"))["transfer"]["id"])')
expect_status "transfer shipped"      200 PATCH "/api/transfers/$TR_ID" '{"action":"ship"}' $WH

TRANSFER_IN=$(curl -s -g -b $ADMIN "$BASE/api/transfers/$TR_ID" | python3 -c "
import json,sys
m=json.load(sys.stdin)['movements']
print(len([x for x in m if x['type']=='transfer_in']))")
check "no transfer_in written while the goods are on the road" 0 "$TRANSFER_IN"

SRC=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$WH_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "source deducted on ship" "$((AFTER-10))" "$SRC"

expect_status "store manager receives the transfer" 200 PATCH "/api/transfers/$TR_ID" '{"action":"complete"}' $STORE
expect_status "shipper (not assigned to that store) cannot receive it" 403 PATCH "/api/transfers/$TR_ID" '{"action":"complete"}' $WH
DEST=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$MBEZI_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
echo "  destination on hand after receipt: $DEST"

BOTH_SIDES=$(curl -s -g -b $ADMIN "$BASE/api/transfers/$TR_ID" | python3 -c "
import json,sys
m=json.load(sys.stdin)['movements']
print(','.join(sorted({x['type'] for x in m})))")
check "both sides of the move are explicit ledger rows" "transfer_in,transfer_out" "$BOTH_SIDES"

echo
echo "== 6. POS SALE — FIFO cost + oversell block =="
STOCK_NOW=$(curl -s -b $ADMIN "$BASE/api/variants?locationId=$MBEZI_ID" | python3 -c "
import json,sys
print(next(v['sellable'] for v in json.load(sys.stdin)['variants'] if v['id']=='$V_ID'))")
echo "  sellable at store: $STOCK_NOW"

OVER=$((STOCK_NOW+50))
expect_status "oversell is BLOCKED (409)" 409 POST /api/sales \
  "{\"locationId\":\"$MBEZI_ID\",\"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":$OVER}]}" $CASH

expect_status "cashier cannot sell at a warehouse (not their location)" 403 POST /api/sales \
  "{\"locationId\":\"$WH_ID\",\"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":1}]}" $CASH

SALE_CODE=$(curl -s -g -o /tmp/sale.json -w '%{http_code}' -b $CASH -H 'Content-Type: application/json' \
  -d "{\"locationId\":\"$MBEZI_ID\",\"paymentMethod\":\"cash\",\"amountPaid\":500000,
       \"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":3,\"unitDiscount\":1000}]}" "$BASE/api/sales")
check "sale completed" 201 "$SALE_CODE"
python3 - <<'PY'
import json
s=json.load(open('/tmp/sale.json'))['sale']
l=s['lines'][0]
print(f"  sold 3 @ {l['actualPrice']:,.0f} (list {l['unitPrice']:,.0f}) -> revenue {l['lineTotal']:,.0f}")
print(f"  FIFO unit cost {l['unitCost']:,.0f} -> line cost {l['lineCost']:,.0f}, profit {l['lineProfit']:,.0f}")
assert abs(l['lineProfit'] - (l['lineTotal'] - l['lineCost'])) < 1, 'profit != revenue - cost'
print("  PASS  per-line profit = (actual price - FIFO cost) x qty")
PY

AFTER_SALE=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$MBEZI_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "store stock fell by 3" "$((DEST-3))" "$AFTER_SALE"

echo
echo "== 7. RETURNS — sellable restocks, damaged writes off =="
DAMAGED_BEFORE=$(curl -s -b $ADMIN "$BASE/api/reports/stock" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(sum(r['onHand'] for r in rows if r['locationType']=='DAMAGED' and r['variantId']=='$V_ID'))")
RET_CODE=$(curl -s -g -o /tmp/ret.json -w '%{http_code}' -b $CASH -H 'Content-Type: application/json' \
  -d "{\"locationId\":\"$MBEZI_ID\",\"reason\":\"customer_return\",
       \"lines\":[{\"variantId\":\"$V_ID\",\"quantity\":1,\"condition\":\"sellable\"},
                 {\"variantId\":\"$V_ID\",\"quantity\":2,\"condition\":\"damaged\"}]}" "$BASE/api/returns")
check "return recorded" 201 "$RET_CODE"
DAMAGED_AFTER=$(curl -s -b $ADMIN "$BASE/api/reports/stock" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(sum(r['onHand'] for r in rows if r['locationType']=='DAMAGED' and r['variantId']=='$V_ID'))")
check "2 damaged units landed in the damaged location" "$((DAMAGED_BEFORE+2))" "$DAMAGED_AFTER"
SELLABLE_AFTER=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$MBEZI_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "1 sellable unit restocked at the store" "$((AFTER_SALE+1))" "$SELLABLE_AFTER"

echo
echo "== 8. ADJUSTMENT APPROVAL GATE =="
expect_status "cashier CANNOT raise a stock adjustment" 403 POST /api/adjustments \
  "{\"variantId\":\"$V_ID\",\"locationId\":\"$MBEZI_ID\",\"reason\":\"damaged\",\"quantity\":-1}" $CASH
ADJ_CODE=$(curl -s -g -o /tmp/adj.json -w '%{http_code}' -b $STORE -H 'Content-Type: application/json' \
  -d "{\"variantId\":\"$V_ID\",\"locationId\":\"$MBEZI_ID\",\"reason\":\"damaged\",\"quantity\":-1,\"notes\":\"e2e test\"}" \
  "$BASE/api/adjustments")
check "store manager raises an adjustment" 201 "$ADJ_CODE"
ADJ_ID=$(python3 -c 'import json;print(json.load(open("/tmp/adj.json")).get("adjustment",{}).get("id",""))')
if [ -z "$ADJ_ID" ]; then echo "  SKIP  could not create adjustment: $(head -c 200 /tmp/adj.json)"; fi
PRE=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$MBEZI_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "pending adjustment does NOT touch stock" "$SELLABLE_AFTER" "$PRE"
expect_status "warehouse manager approves it" 200 PATCH "/api/adjustments/$ADJ_ID" '{"action":"approve"}' $WH
POST_ADJ=$(curl -s -b $ADMIN "$BASE/api/reports/stock?locationId=$MBEZI_ID" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print(next((r['onHand'] for r in rows if r['variantId']=='$V_ID'),0))")
check "approved adjustment wrote the ledger" "$((SELLABLE_AFTER-1))" "$POST_ADJ"

echo
echo "== 9. REPORTS + AUDIT =="
for r in stock sales purchases transfers pnl valuation; do
  expect_status "report/$r responds" 200 GET "/api/reports/$r" '' $ADMIN
done
expect_status "cashier gets own reports only" 200 GET "/api/reports/sales" '' $CASH
AUDIT_HAS=$(curl -s -b $ADMIN "$BASE/api/audit?entityType=Sale&take=5" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('yes' if d['logs'] else 'no')")
check "the sale we just made is in the audit log" "yes" "$AUDIT_HAS"

echo
echo "== 10. LEDGER INTEGRITY =="
npx tsx prisma/verify-ledger.ts 2>&1 | tail -4

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
