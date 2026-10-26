/* =====================================================================
 * 第 5 周：按键说话（板载 MEMS 麦克风 I2S 录音 → 标准 WAV → 上传服务端）
 *
 * ★ 音频来源 = 板载数字 MEMS 麦克风；录音发生在【板端】，
 *   识别与播放在【电脑浏览器】—— 本板没有扬声器，播放只能在电脑端。
 *
 * 引脚依据（全部来自官方 esp-bsp，不靠猜测；行号对应当前 master）：
 *   esp-bsp: bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h
 *     L82  #define BSP_I2S_MCLK (GPIO_NUM_NC)   本板麦克风不需要 MCLK
 *     L83  #define BSP_I2S_SCLK (GPIO_NUM_41)   BCLK
 *     L84  #define BSP_I2S_LCLK (GPIO_NUM_42)   WS / LRCK
 *     L85  #define BSP_I2S_DOUT (GPIO_NUM_NC)   没有扬声器 → 无 DOUT
 *     L86  #define BSP_I2S_DSIN (GPIO_NUM_2)    麦克风数据（只读）
 *     L56  #define BSP_CAPS_AUDIO           1
 *     L57  #define BSP_CAPS_AUDIO_SPEAKER   0  ★ 无扬声器
 *     L58  #define BSP_CAPS_AUDIO_MIC       1  ★ 有麦克风
 *   esp-bsp: bsp/esp32_s3_eye/src/bsp_audio.c
 *     L49  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(CONFIG_BSP_I2S_NUM, I2S_ROLE_MASTER);
 *     L51  i2s_new_channel(&chan_cfg, NULL, &i2s_rx_chan);   ← 只建 RX 通道
 *     L34  .slot_cfg = I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
 *     L101 .dev_type = ESP_CODEC_DEV_TYPE_IN;  .codec_if = NULL;
 *          ★ codec_if 为 NULL = 没有 ES7210/ES8311 之类受 I2C 控制的 codec 芯片，
 *            数据总线直连麦克风，走【标准 I2S（Philips）】，不是 PDM。
 *   → 结论：直接 I2S、主机模式、16 bit、单声道；无 codec 芯片、无扬声器。
 *
 * 按键依据：
 *   esp-bsp: bsp/esp32_s3_eye/src/bsp_button.c L79-L82
 *     BSP_BUTTON_5 是 GPIO 直连按键：gpio_num = BSP_BUTTON_5_IO，active_level = 0
 *   esp-bsp: bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h L124
 *     #define BSP_BUTTON_5_IO (GPIO_NUM_0)   ← 板上 BOOT 功能键，按下为低
 *   ★ 为什么不复用 ADC 分压的 4 个键：它们在第 3 周承担「求助 / 取消」，
 *     复用会打乱已有求助闭环，违反本周「不改已有上报/求助/摄像头逻辑」的约束。
 * ===================================================================== */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* LED 指示档位：main.c 的 ui_task 据此驱动已有 led_ 接口。
 * 串口日志只有坐在电脑旁的人能看到；用户按键瞬间必须先看 LED。 */
typedef enum {
    VOICE_LED_NONE = 0,   /* 语音空闲：LED 交回第 3 周的求助状态机 */
    VOICE_LED_RECORDING,  /* 常亮：正在录音 */
    VOICE_LED_UPLOADING,  /* 快闪（120ms）：正在上传 */
    VOICE_LED_OK,         /* 慢闪（400ms）：上传成功 */
    VOICE_LED_ERROR,      /* 急促闪烁（60ms）：失败（原因见串口 ESP_LOGE） */
} voice_led_t;

/* 启动语音模块：配置 BOOT 键 GPIO、分配录音缓冲（PSRAM）、创建录音与按键任务。
 * 任一环节失败都会 ESP_LOGE 并降级，其它功能（上报/求助/摄像头）不受影响。 */
void voice_record_init(void);

/* 按键语义：非录音中 → 开始；录音中 → 结束并上传。返回是否被接受。 */
bool voice_record_toggle(void);

/* 当前应显示的 LED 档位（线程安全，只读）。 */
voice_led_t voice_record_led(void);

/* 是否正在录音（供 UI / 日志判断）。 */
bool voice_record_is_recording(void);
