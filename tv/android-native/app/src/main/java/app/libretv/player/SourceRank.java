package app.libretv.player;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Same order as the website's rankSources, using what this app can measure:
 * a source that failed the probe goes back, then higher clarity, more episodes,
 * fewer inserted ads. Unmeasured sources stay neutral so they are not punished
 * for still being in flight.
 */
final class SourceRank {
    private static final Pattern EPISODES = Pattern.compile("(?:^|[^\\d])(\\d{1,4})\\s*[集话話]");

    private SourceRank() {}

    static int episodeCount(String remarks) {
        if (remarks == null || remarks.isEmpty()) return 0;
        Matcher matcher = EPISODES.matcher(remarks);
        if (!matcher.find()) return 0;
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 0 failed, 1 unknown or SD, 2 is 720p, 3 is 1080p and above. Matches qualityTier. */
    static int tier(Playlist.Report report, boolean probed) {
        if (!probed || report == null) return 1;
        if (!report.measured) return 0;
        if (report.height >= 1000) return 3;
        if (report.height >= 700) return 2;
        return 1;
    }

    static int failing(Playlist.Report report, boolean probed) {
        if (!probed || report == null) return 0;
        return report.measured ? 0 : 1;
    }

    static int ads(Playlist.Report report) {
        if (report == null || report.adSeconds < 0) return 0;
        return report.adSeconds;
    }
}
