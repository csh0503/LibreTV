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

    public Card(String title, String image, String subtitle, String vodId, String sourceJson, int episode, int positionSeconds) {
        this(title, image, subtitle, vodId, sourceJson, episode, positionSeconds, 0);
    }

    public Card(String title, String image, String subtitle, String vodId, String sourceJson, int episode, int positionSeconds, int progressPercent) {
        this.title = title == null ? "" : title;
        this.image = image == null ? "" : image;
        this.subtitle = subtitle == null ? "" : subtitle;
        this.vodId = vodId == null ? "" : vodId;
        this.sourceJson = sourceJson == null ? "" : sourceJson;
        this.episode = episode;
        this.positionSeconds = positionSeconds;
        this.progressPercent = Math.max(0, Math.min(100, progressPercent));
    }

    public boolean canOpenDetail() {
        return !vodId.isEmpty() && !sourceJson.isEmpty();
    }
}
