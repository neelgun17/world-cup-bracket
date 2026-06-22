"""Build teams.json = {group, name, abbr, elo} for the 48 teams.

Joins ESPN roster (group/name/abbr) with eloratings World.tsv (ISO-2-ish code -> Elo).
Run: python3 wc_sim/data/build_teams.py /tmp/espn_st.json
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).parent

# ESPN displayName -> eloratings World.tsv code
NAME2CODE = {
    "Mexico":"MX","Czechia":"CZ","South Korea":"KR","South Africa":"ZA",
    "Canada":"CA","Bosnia-Herzegovina":"BA","Switzerland":"CH","Qatar":"QA",
    "Brazil":"BR","Scotland":"SQ","Haiti":"HT","Morocco":"MA",
    "Paraguay":"PY","Türkiye":"TR","Australia":"AU","United States":"US",
    "Ecuador":"EC","Germany":"DE","Ivory Coast":"CI","Curaçao":"CW",
    "Netherlands":"NL","Sweden":"SE","Japan":"JP","Tunisia":"TN",
    "Belgium":"BE","Iran":"IR","Egypt":"EG","New Zealand":"NZ",
    "Spain":"ES","Uruguay":"UY","Saudi Arabia":"SA","Cape Verde":"CV",
    "Norway":"NO","France":"FR","Senegal":"SN","Iraq":"IQ",
    "Argentina":"AR","Austria":"AT","Algeria":"DZ","Jordan":"JO",
    "Colombia":"CO","Portugal":"PT","Uzbekistan":"UZ","Congo DR":"CD",
    "England":"EN","Croatia":"HR","Panama":"PA","Ghana":"GH",
}
DEFAULT_ELO = 1500  # sentinel-ish fallback for any unmatched team

def load_elo(tsv: Path) -> dict:
    code2elo = {}
    for line in tsv.read_text().splitlines():
        p = line.split("\t")
        if len(p) > 3 and p[2]:
            try:
                code2elo[p[2]] = int(p[3])
            except ValueError:
                pass
    return code2elo

def main():
    espn = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else json.load(open("/tmp/espn_st.json"))
    code2elo = load_elo(HERE / "eloratings_world.tsv")
    teams, misses = [], []
    for g in espn["children"]:
        grp = g["name"].replace("Group ", "")
        for en in g["standings"]["entries"]:
            name = en["team"]["displayName"]
            abbr = en["team"].get("abbreviation")
            code = NAME2CODE.get(name)
            elo = code2elo.get(code) if code else None
            if elo is None:
                misses.append((name, code))
                elo = DEFAULT_ELO
            teams.append({"group": grp, "name": name, "abbr": abbr, "code": code, "elo": elo})
    teams.sort(key=lambda t: (t["group"], -t["elo"]))
    (HERE / "teams.json").write_text(json.dumps(teams, indent=2, ensure_ascii=False))
    print(f"Wrote teams.json: {len(teams)} teams; Elo range {min(t['elo'] for t in teams)}-{max(t['elo'] for t in teams)}")
    if misses:
        print("MISSES (defaulted to", DEFAULT_ELO, "):", misses)
    else:
        print("No misses; all 48 teams matched an Elo.")

if __name__ == "__main__":
    main()
