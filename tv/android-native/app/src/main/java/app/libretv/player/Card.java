package app.libretv.player;

/** A poster the home and search screens can open. */
public final class Card {
    public final String title;
    public final String image;
    public final String subtitle;
    public final String vodId;
    public final String sourceJson;
    public final int episode;
    public final int positionSeconds;
    /** 0 hides the bar. Continue-watching uses playback position / duration. */
    public final int progressPercent;
    /** Trailing "查看全部" card: opens the browse page for this shelf instead of a title. */
    public final boolean seeAll;
    /** Browse channel id, only used by seeAll cards. */
    public final String channel;

    public Card(String title, String image, String subtitle, String vodId, String sourceJson, int episode, int positionSeconds) {
        this(title, image, subtitle, vodId, sourceJson, episode, positionSeconds, 0, false, "");
    }

    public Card(String title, String image, String subtitle, String vodId, String sourceJson, int episode, int positionSeconds, int progressPercent) {
        this(title, image, subtitle, vodId, sourceJson, episode, positionSeconds, progressPercent, false, "");
    }

    private Card(String title, String image, String subtitle, String vodId, String sourceJson,
                 int episode, int positionSeconds, int progressPercent, boolean seeAll, String channel) {
        this.title = title == null ? "" : title;
        this.image = image == null ? "" : image;
        this.subtitle = subtitle == null ? "" : subtitle;
        this.vodId = vodId == null ? "" : vodId;
        this.sourceJson = sourceJson == null ? "" : sourceJson;
        this.episode = episode;
        this.positionSeconds = positionSeconds;
        this.progressPercent = Math.max(0, Math.min(100, progressPercent));
        this.seeAll = seeAll;
        this.channel = channel == null ? "" : channel;
    }

    /** Last card of a shelf: "查看全部 →". */
    public static Card seeAll(String channel, String label) {
        return new Card(label, "", "打开分类片库", "", "", 0, 0, 0, true, channel);
    }

    public boolean canOpenDetail() {
        return !vodId.isEmpty() && !sourceJson.isEmpty();
    }
}
