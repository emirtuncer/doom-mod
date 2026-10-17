// doomgeneric platform for the Claude Code "doom" mod.
//
// Frames go to stdout, one line each, in one of two modes:
//   cells:  "<cols> <rows> <base64>", a Raster's cells: u32 little-endian
//           triplets of a 2x2 quadrant glyph, its ink and its ground colour.
//   pixels: "P <width> <height> <generation> <path>", the frame written as
//           raw RGB to <path>, one of a few files used in turn, for an Image.
// Keys: the mod rewrites a small text file, one "<seq> <word>" per line: a key,
// or "size <cols> <rows>", or "mode cells|pixels". A terminal reports presses
// only, so a key is held until its repeats stop.

#include "doomkeys.h"
#include "doomgeneric.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#define dup _dup
#define dup2 _dup2
#define fileno _fileno
#define fdopen _fdopen
#else
#include <time.h>
#include <unistd.h>
#endif

#define PIXEL_FILES 4

static int s_Cols = 160;
static int s_Rows = 60;
static int s_FrameMs = 50;
static int s_IsPixels = 0;
static const char *s_KeysPath = NULL;
static const char *s_FramesPrefix = NULL;

static uint8_t *s_Cells;
static char *s_Line;
static uint8_t *s_Rgb;
static unsigned long s_Generation;
static uint32_t s_LastFrame;
static FILE *s_Out; // the real stdout: frames only; the engine's own prints go to stderr

// --- cells ----------------------------------------------------------------

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64(const uint8_t *in, size_t n, char *out)
{
    size_t o = 0, i = 0;
    for (; i + 2 < n; i += 3) {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
    }
    if (i < n) {
        uint32_t v = in[i] << 16;
        if (i + 1 < n) v |= in[i + 1] << 8;
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < n ? B64[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    return o;
}

static void put32(uint8_t *at, uint32_t v)
{
    at[0] = v & 0xff;
    at[1] = (v >> 8) & 0xff;
    at[2] = (v >> 16) & 0xff;
    at[3] = (v >> 24) & 0xff;
}

typedef struct {
    int r, g, b;
} Rgb;

// The average of the screen area under subpixel (x, y) of a cols*2 by rows*2 grid.
static Rgb subpixel(int x, int y)
{
    int x0 = x * DOOMGENERIC_RESX / (s_Cols * 2);
    int x1 = (x + 1) * DOOMGENERIC_RESX / (s_Cols * 2);
    int y0 = y * DOOMGENERIC_RESY / (s_Rows * 2);
    int y1 = (y + 1) * DOOMGENERIC_RESY / (s_Rows * 2);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    Rgb sum = {0, 0, 0};
    for (int sy = y0; sy < y1; sy++) {
        for (int sx = x0; sx < x1; sx++) {
            uint32_t p = DG_ScreenBuffer[sy * DOOMGENERIC_RESX + sx];
            sum.r += (p >> 16) & 0xff;
            sum.g += (p >> 8) & 0xff;
            sum.b += p & 0xff;
        }
    }
    int n = (x1 - x0) * (y1 - y0);
    Rgb avg = {sum.r / n, sum.g / n, sum.b / n};
    return avg;
}

static int distance(Rgb a, Rgb b)
{
    int dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return dr * dr * 2 + dg * dg * 4 + db * db * 3;
}

static uint32_t packed(Rgb c)
{
    return ((uint32_t)c.r << 16) | ((uint32_t)c.g << 8) | (uint32_t)c.b;
}

// Quadrant glyphs by mask: bit 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right.
static const uint32_t QUADRANT[16] = {
    0x0020, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B,
    0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588,
};

// One cell: its four subpixels split into the two colours furthest apart,
// the glyph's ink taking one and the cell's ground the other.
static void quadrantCell(int cx, int cy, uint8_t *cell)
{
    Rgb p[4] = {
        subpixel(cx * 2, cy * 2), subpixel(cx * 2 + 1, cy * 2),
        subpixel(cx * 2, cy * 2 + 1), subpixel(cx * 2 + 1, cy * 2 + 1),
    };
    int a = 0, b = 0, widest = -1;
    for (int i = 0; i < 4; i++) {
        for (int j = i + 1; j < 4; j++) {
            int d = distance(p[i], p[j]);
            if (d > widest) widest = d, a = i, b = j;
        }
    }
    int mask = 0;
    Rgb ink = {0, 0, 0}, ground = {0, 0, 0};
    int inks = 0, grounds = 0;
    for (int i = 0; i < 4; i++) {
        if (distance(p[i], p[a]) <= distance(p[i], p[b])) {
            mask |= 1 << i;
            ink.r += p[i].r, ink.g += p[i].g, ink.b += p[i].b, inks++;
        } else {
            ground.r += p[i].r, ground.g += p[i].g, ground.b += p[i].b, grounds++;
        }
    }
    ink.r /= inks, ink.g /= inks, ink.b /= inks;
    if (grounds == 0) {
        ground = ink;
    } else {
        ground.r /= grounds, ground.g /= grounds, ground.b /= grounds;
    }
    put32(cell, QUADRANT[mask]);
    put32(cell + 4, packed(ink));
    put32(cell + 8, packed(ground));
}

static void writeLine(size_t n)
{
    if (fwrite(s_Line, 1, n, s_Out) != n || fflush(s_Out) != 0) exit(0);
}

static void emitCells(void)
{
    uint8_t *cell = s_Cells;
    for (int y = 0; y < s_Rows; y++) {
        for (int x = 0; x < s_Cols; x++) {
            quadrantCell(x, y, cell);
            cell += 12;
        }
    }
    // the size travels with the frame, as it can change
    size_t n = (size_t)sprintf(s_Line, "%d %d ", s_Cols, s_Rows);
    n += base64(s_Cells, (size_t)s_Cols * s_Rows * 12, s_Line + n);
    s_Line[n++] = '\n';
    writeLine(n);
}

// --- pixels ---------------------------------------------------------------

static void emitPixels(void)
{
    size_t count = (size_t)DOOMGENERIC_RESX * DOOMGENERIC_RESY;
    for (size_t i = 0; i < count; i++) {
        uint32_t p = DG_ScreenBuffer[i];
        s_Rgb[i * 3] = (p >> 16) & 0xff;
        s_Rgb[i * 3 + 1] = (p >> 8) & 0xff;
        s_Rgb[i * 3 + 2] = p & 0xff;
    }
    // files used in turn, so the terminal never reads one being written
    char path[4096];
    s_Generation++;
    snprintf(path, sizeof path, "%s%lu.rgb", s_FramesPrefix, s_Generation % PIXEL_FILES);
    FILE *f = fopen(path, "wb");
    if (f == NULL) return;
    size_t written = fwrite(s_Rgb, 1, count * 3, f);
    fclose(f);
    if (written != count * 3) return;
    size_t n = (size_t)snprintf(s_Line, 4200, "P %d %d %lu %s\n", DOOMGENERIC_RESX, DOOMGENERIC_RESY, s_Generation, path);
    writeLine(n);
}

// --- keys -----------------------------------------------------------------

#define HELD_MAX 32
#define QUEUE_SIZE 64

typedef struct {
    unsigned char key;
    uint32_t until;
} Held;

static Held s_Held[HELD_MAX];
static int s_HeldCount;
static unsigned short s_Queue[QUEUE_SIZE];
static int s_QueueRead, s_QueueWrite;
static long long s_LastSeq = -1;

static void enqueue(int pressed, unsigned char key)
{
    s_Queue[s_QueueWrite] = (unsigned short)((pressed << 8) | key);
    s_QueueWrite = (s_QueueWrite + 1) % QUEUE_SIZE;
}

static unsigned char toDoomKey(const char *name)
{
    if (strcmp(name, "up") == 0 || strcmp(name, "w") == 0) return KEY_UPARROW;
    if (strcmp(name, "down") == 0 || strcmp(name, "s") == 0) return KEY_DOWNARROW;
    if (strcmp(name, "left") == 0 || strcmp(name, "a") == 0) return KEY_LEFTARROW;
    if (strcmp(name, "right") == 0 || strcmp(name, "d") == 0) return KEY_RIGHTARROW;
    if (strcmp(name, "q") == 0) return KEY_STRAFE_L;
    if (strcmp(name, "e") == 0) return KEY_STRAFE_R;
    if (strcmp(name, "space") == 0 || strcmp(name, "f") == 0) return KEY_FIRE;
    if (strcmp(name, "r") == 0) return KEY_USE;
    if (strcmp(name, "return") == 0) return KEY_ENTER;
    if (strcmp(name, "p") == 0 || strcmp(name, "backspace") == 0) return KEY_ESCAPE;
    if (strcmp(name, "tab") == 0 || strcmp(name, "m") == 0) return KEY_TAB;
    if (strlen(name) == 1 && name[0] > ' ' && name[0] < 127) return (unsigned char)tolower(name[0]);
    return 0;
}

// The first press holds a key past the terminal's repeat delay; each repeat
// after it holds it a little longer.
static void press(unsigned char key, uint32_t now)
{
    for (int i = 0; i < s_HeldCount; i++) {
        if (s_Held[i].key == key) {
            s_Held[i].until = now + 120;
            return;
        }
    }
    if (s_HeldCount == HELD_MAX) return;
    s_Held[s_HeldCount].key = key;
    s_Held[s_HeldCount].until = now + 550;
    s_HeldCount++;
    enqueue(1, key);
}

static void releaseExpired(uint32_t now)
{
    for (int i = 0; i < s_HeldCount;) {
        if ((int32_t)(now - s_Held[i].until) >= 0) {
            enqueue(0, s_Held[i].key);
            s_Held[i] = s_Held[--s_HeldCount];
        } else {
            i++;
        }
    }
}

static void allocate(void)
{
    free(s_Cells);
    free(s_Line);
    s_Cells = malloc((size_t)s_Cols * s_Rows * 12);
    s_Line = malloc((size_t)s_Cols * s_Rows * 16 + 4200);
}

static void resize(int cols, int rows)
{
    if (cols < 8 || cols > 512 || rows < 4 || rows > 256 || (cols == s_Cols && rows == s_Rows)) return;
    s_Cols = cols;
    s_Rows = rows;
    allocate();
}

static void readKeys(uint32_t now)
{
    if (s_KeysPath == NULL) return;
    FILE *f = fopen(s_KeysPath, "rb");
    if (f == NULL) return;
    char line[64];
    while (fgets(line, sizeof line, f) != NULL) {
        long long seq;
        char name[32];
        if (strchr(line, '\n') == NULL) break; // a line still being written
        if (sscanf(line, "%lld %31s", &seq, name) != 2 || seq <= s_LastSeq) continue;
        s_LastSeq = seq;
        if (strcmp(name, "size") == 0) {
            int cols, rows;
            if (sscanf(line, "%lld %31s %d %d", &seq, name, &cols, &rows) == 4) resize(cols, rows);
            continue;
        }
        if (strcmp(name, "mode") == 0) {
            char mode[16];
            if (sscanf(line, "%lld %31s %15s", &seq, name, mode) == 3) {
                s_IsPixels = strcmp(mode, "pixels") == 0 && s_FramesPrefix != NULL;
            }
            continue;
        }
        unsigned char key = toDoomKey(name);
        if (key != 0) press(key, now);
    }
    fclose(f);
}

// --- platform -------------------------------------------------------------

void DG_Init(void)
{
    allocate();
    s_Rgb = malloc((size_t)DOOMGENERIC_RESX * DOOMGENERIC_RESY * 3);
}

void DG_DrawFrame(void)
{
    uint32_t now = DG_GetTicksMs();
    if (now - s_LastFrame < (uint32_t)s_FrameMs) return;
    s_LastFrame = now;
    if (s_IsPixels) emitPixels();
    else emitCells();
}

void DG_SleepMs(uint32_t ms)
{
#ifdef _WIN32
    Sleep(ms);
#else
    struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
#endif
}

uint32_t DG_GetTicksMs(void)
{
#ifdef _WIN32
    return (uint32_t)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
#endif
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    if (s_QueueRead == s_QueueWrite) {
        uint32_t now = DG_GetTicksMs();
        readKeys(now);
        releaseExpired(now);
        if (s_QueueRead == s_QueueWrite) return 0;
    }
    unsigned short data = s_Queue[s_QueueRead];
    s_QueueRead = (s_QueueRead + 1) % QUEUE_SIZE;
    *pressed = data >> 8;
    *doomKey = data & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

// doom-claude -cols N -rows N -fps N -keys <file> [-frames <path prefix>]
//             [-mode cells|pixels] -iwad <wad> [doom args]
int main(int argc, char **argv)
{
    fflush(stdout);
    int frames = dup(fileno(stdout));
#ifdef _WIN32
    _setmode(frames, _O_BINARY); // no "\r" before each "\n"
#endif
    s_Out = fdopen(frames, "wb");
    dup2(fileno(stderr), fileno(stdout));
    char **rest = malloc(sizeof(char *) * (argc + 1));
    int n = 0;
    rest[n++] = argv[0];
    for (int i = 1; i < argc; i++) {
        if (i + 1 < argc && strcmp(argv[i], "-cols") == 0) s_Cols = atoi(argv[++i]);
        else if (i + 1 < argc && strcmp(argv[i], "-rows") == 0) s_Rows = atoi(argv[++i]);
        else if (i + 1 < argc && strcmp(argv[i], "-fps") == 0) s_FrameMs = 1000 / atoi(argv[++i]);
        else if (i + 1 < argc && strcmp(argv[i], "-keys") == 0) s_KeysPath = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "-frames") == 0) s_FramesPrefix = argv[++i];
        else if (i + 1 < argc && strcmp(argv[i], "-mode") == 0) s_IsPixels = strcmp(argv[++i], "pixels") == 0;
        else rest[n++] = argv[i];
    }
    rest[n] = NULL;
    if (s_Cols < 8 || s_Cols > 512 || s_Rows < 4 || s_Rows > 256) {
        fprintf(stderr, "bad -cols/-rows\n");
        return 2;
    }
    if (s_IsPixels && s_FramesPrefix == NULL) s_IsPixels = 0;
    doomgeneric_Create(n, rest);
    for (;;) doomgeneric_Tick();
}
