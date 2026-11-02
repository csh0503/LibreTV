package app.libretv.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 剧名归一化和清晰度分档都是纯函数，但直接影响「同一部片会不会重复出现」和「片源卡片上写的清晰度」。
 * 这些规则改起来很容易碰坏，先钉住。
 */
public class WorkKeyTest {

    @Test
    public void 去掉季数后是同一部片() {
        assertEquals(WorkKey.of("航海王 第二季"), WorkKey.of("航海王"));
        assertEquals(WorkKey.of("斗罗大陆 第3季"), WorkKey.of("斗罗大陆"));
        assertEquals(WorkKey.of("进击的巨人 Season 2"), WorkKey.of("进击的巨人"));
        assertEquals(WorkKey.of("某科学的超电磁炮 第二期"), WorkKey.of("某科学的超电磁炮"));
    }

    @Test
    public void 别名折叠成同一个键() {
        assertTrue(WorkKey.same("海贼王", "航海王"));
        assertTrue(WorkKey.same("死神", "境·界"));
        assertTrue(WorkKey.same("机器猫", "哆啦A梦"));
    }

    @Test
    public void 全角半角空格标点都不影响() {
        assertTrue(WorkKey.same("ＳＰＹ×ＦＡＭＩＬＹ", "spy family"));
        assertTrue(WorkKey.same("名侦探柯南 ", " 名侦探柯南"));
        assertTrue(WorkKey.same("Re:从零开始的异世界生活", "Re 从零开始的异世界生活"));
    }

    @Test
    public void 不同片不会误判相同() {
        assertFalse(WorkKey.same("灌篮高手", "足球小将"));
        assertFalse(WorkKey.same("", ""));
        assertEquals("", WorkKey.of(null));
    }

    @Test
    public void 清晰度分档() {
        assertEquals("4K", Playlist.Report.qualityName(2160));
        assertEquals("1080P", Playlist.Report.qualityName(1080));
        assertEquals("720P", Playlist.Report.qualityName(720));
        assertEquals("480P", Playlist.Report.qualityName(480));
        assertEquals("标清", Playlist.Report.qualityName(360));
        assertEquals("", Playlist.Report.qualityName(0));
    }
}
