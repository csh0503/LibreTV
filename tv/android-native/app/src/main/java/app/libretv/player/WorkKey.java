package app.libretv.player;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Same-show key used by the website history row: drop the season, then fold known aliases. */
public final class WorkKey {
    private static final Pattern SEASON = Pattern.compile(
            "\\s*(?:第[一二三四五六七八九十百0-9]+[季部篇期]|(?:Season|Part|Part\\.)\\s*\\d+|[ⅠⅡⅢⅣⅤⅥ]+)\\s*$",
            Pattern.CASE_INSENSITIVE);
    private static final String[][] ALIASES = {
            {"航海王", "海贼王", "ONE PIECE"},
            {"黑色五叶草", "黑色四叶草", "Black Clover"},
            {"境·界", "死神", "BLEACH"},
            {"哆啦A梦", "机器猫", "小叮当"},
            {"宝可梦", "宠物小精灵", "神奇宝贝", "口袋妖怪", "精灵宝可梦"},
            {"数码宝贝", "数码暴龙"},
            {"龙珠", "七龙珠"},
            {"灌篮高手", "男儿当入樽"},
            {"名侦探柯南", "柯南"},
            {"新世纪福音战士", "福音战士", "EVA"},
            {"电锯人", "链锯人"},
            {"间谍过家家", "间谍家家酒"},
            {"药屋少女的呢喃", "药师少女的呢喃"},
            {"关于我转生变成史莱姆这档事", "转生史莱姆"},
            {"Re:从零开始的异世界生活", "从零开始的异世界生活"},
            {"五等分的新娘", "五等分的花嫁"},
            {"东京喰种", "东京食尸鬼"},
            {"全职猎人", "HUNTER×HUNTER"},
            {"千与千寻", "神隐少女"},
            {"哈尔的移动城堡", "霍尔的移动城堡"},
            {"蜘蛛侠", "蜘蛛人"},
            {"钢铁侠", "铁甲奇侠"},
            {"星球大战", "星际大战"},
            {"指环王", "魔戒"},
            {"哈利·波特", "哈利波特"},
            {"加勒比海盗", "神鬼奇航"},
            {"速度与激情", "狂野极速"},
            {"碟中谍", "职业特工队"},
            {"驯龙高手", "驯龙记"},
            {"疯狂动物城", "动物方城市"},
            {"寻梦环游记", "玩转极乐世界"},
            {"冰雪奇缘", "魔雪奇缘"},
            {"超人总动员", "超人特工队"},
            {"头脑特工队", "脑筋急转弯"},
            {"飞屋环游记", "天外奇迹"},
            {"机器人总动员", "瓦力"},
            {"玩具总动员", "反斗奇兵"},
            {"我的英雄学院", "我的英雄学园"},
            {"反叛的鲁路修", "Code Geass"},
            {"死亡笔记", "死亡笔记本"},
            {"命运石之门", "Steins;Gate"},
            {"某科学的超电磁炮", "科学超电磁炮"},
            {"更衣人偶坠入爱河", "恋上换装娃娃"},
            {"足球小将", "队长小翼"},
            {"美少女战士", "水手月亮"},
            {"致不灭的你", "给不灭的你"},
            {"迷宫饭", "舌尖上的地下城"},
            {"蓝色监狱", "蓝锁"},
            {"辉夜大小姐想让我告白", "辉夜姬想让人告白"},
            {"无职转生", "无职转生～到了异世界就拿出真本事～"},
            {"赛博朋克：边缘行者", "赛博朋克：边缘跑手", "Cyberpunk: Edgerunners"},
            {"葬送的芙莉莲", "葬送的芙莉蓮", "芙莉莲"},
            {"孤独摇滚", "孤独摇滚！"},
            {"我推的孩子", "【我推的孩子】"},
            {"败犬女主太多了", "败北女角太多了"},
    };
    private static final Map<String, String> ALIAS = new LinkedHashMap<>();

    static {
        for (String[] group : ALIASES) {
            String canon = compact(group[0]);
            for (String name : group) ALIAS.put(compact(name), canon);
        }
    }

    private WorkKey() {}

    public static boolean same(String a, String b) {
        String ka = of(a);
        String kb = of(b);
        return !ka.isEmpty() && ka.equals(kb);
    }

    public static String of(String title) {
        if (title == null) return "";
        String stripped = stripSeason(Normalizer.normalize(title, Normalizer.Form.NFKC).trim());
        String compact = compact(stripped);
        String alias = ALIAS.get(compact);
        return alias == null ? compact : alias;
    }

    public static List<JSONObject> collapse(JSONArray history) {
        List<JSONObject> items = new ArrayList<>();
        if (history == null) return items;
        for (int i = 0; i < history.length(); i++) {
            JSONObject item = history.optJSONObject(i);
            if (item != null && !item.optString("title").isEmpty()) items.add(item);
        }
        items.sort((a, b) -> Long.compare(b.optLong("timestamp"), a.optLong("timestamp")));
        LinkedHashMap<String, JSONObject> kept = new LinkedHashMap<>();
        for (JSONObject item : items) {
            String key = of(item.optString("title"));
            if (key.isEmpty()) key = item.optString("sourceKey") + ":" + item.optString("vodId");
            kept.putIfAbsent(key, item);
        }
        return new ArrayList<>(kept.values());
    }

    private static String stripSeason(String title) {
        String current = title;
        String previous;
        do {
            previous = current;
            current = SEASON.matcher(current).replaceFirst("").trim();
        } while (!current.equals(previous));
        return current;
    }

    private static String compact(String title) {
        return Normalizer.normalize(title, Normalizer.Form.NFKC)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[\\s\\p{P}\\p{S}]+", "");
    }
}
