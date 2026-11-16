import { createTheme } from '@mui/material/styles'

export const FONT_FAMILIES = {
  GOTHIC: '"BusanDandiGothic", "Malgun Gothic", -apple-system, BlinkMacSystemFont, sans-serif',
  MYEONGJO: '"BusanDandiMyeongjo", "BusanDandiGothic", Georgia, serif',
  MONO: '"Cascadia Code", Consolas, "BusanDandiGothic", monospace'
} as const

export const ROYAL_COLORS = {
  BG_DEEP: '#101114',
  BG_SURFACE: '#1B1C20',
  BG_PILL: '#1E1F24',
  BG_PILL_HOVER: '#272930',
  BG_USER_BUBBLE: '#282A32',
  GOLD_MAIN: '#D4AF5A',
  GOLD_LIGHT: '#EAD08A',
  GOLD_DIM: 'rgba(212, 175, 90, 0.22)',
  SAGE_MAIN: '#C8B898',
  SAGE_LIGHT: '#E5D8BD',
  SAGE_DIM: 'rgba(200, 184, 152, 0.24)',
  BORDER_SUBTLE: 'rgba(255, 255, 255, 0.08)',
  CRIMSON_MAIN: '#C25454',
  TEXT_PRIMARY: '#E8EAED',
  TEXT_SECONDARY: '#9AA0A6'
} as const

export const ck3DarkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: ROYAL_COLORS.GOLD_MAIN,
      light: ROYAL_COLORS.GOLD_LIGHT,
      dark: '#A68336',
      contrastText: '#101114'
    },
    secondary: {
      main: ROYAL_COLORS.SAGE_MAIN,
      light: ROYAL_COLORS.SAGE_LIGHT,
      dark: '#9B8B6C',
      contrastText: '#101114'
    },
    success: {
      main: '#5BB98B',
      contrastText: '#101114'
    },
    warning: {
      main: '#E2A84B',
      contrastText: '#101114'
    },
    error: {
      main: '#E06666',
      contrastText: '#101114'
    },
    info: {
      main: ROYAL_COLORS.SAGE_MAIN,
      contrastText: '#101114'
    },
    background: {
      default: ROYAL_COLORS.BG_DEEP,
      paper: ROYAL_COLORS.BG_SURFACE
    },
    text: {
      primary: ROYAL_COLORS.TEXT_PRIMARY,
      secondary: ROYAL_COLORS.TEXT_SECONDARY
    },
    divider: ROYAL_COLORS.BORDER_SUBTLE
  },
  typography: {
    fontFamily: FONT_FAMILIES.GOTHIC,
    h4: {
      fontFamily: FONT_FAMILIES.MYEONGJO,
      fontWeight: 500,
      letterSpacing: '-0.02em'
    },
    h5: {
      fontFamily: FONT_FAMILIES.MYEONGJO,
      fontWeight: 700,
      letterSpacing: '-0.015em'
    },
    h6: {
      fontFamily: FONT_FAMILIES.MYEONGJO,
      fontWeight: 700,
      letterSpacing: '-0.01em'
    },
    subtitle1: {
      fontFamily: FONT_FAMILIES.GOTHIC,
      fontWeight: 500
    },
    subtitle2: {
      fontFamily: FONT_FAMILIES.GOTHIC,
      fontWeight: 700
    },
    body1: {
      fontFamily: FONT_FAMILIES.GOTHIC,
      lineHeight: 1.75
    },
    body2: {
      fontFamily: FONT_FAMILIES.GOTHIC,
      lineHeight: 1.75
    },
    button: {
      fontFamily: FONT_FAMILIES.GOTHIC,
      fontWeight: 500,
      textTransform: 'none'
    }
  },
  shape: {
    borderRadius: 8
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: ROYAL_COLORS.BG_DEEP,
          color: ROYAL_COLORS.TEXT_PRIMARY,
          fontFamily: FONT_FAMILIES.GOTHIC,
          overflow: 'hidden',
          WebkitFontSmoothing: 'antialiased'
        },
        '*::-webkit-scrollbar': {
          width: '7px',
          height: '7px'
        },
        '*::-webkit-scrollbar-track': {
          background: 'transparent'
        },
        '*::-webkit-scrollbar-thumb': {
          background: 'rgba(255, 255, 255, 0.14)',
          borderRadius: '4px'
        },
        '*::-webkit-scrollbar-thumb:hover': {
          background: 'rgba(212, 175, 90, 0.4)'
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: '8px',
          paddingLeft: 14,
          paddingRight: 14
        },
        containedPrimary: {
          backgroundColor: ROYAL_COLORS.GOLD_MAIN,
          color: '#101114',
          fontWeight: 700,
          '&:hover': {
            backgroundColor: ROYAL_COLORS.GOLD_LIGHT
          }
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: '8px',
          fontFamily: FONT_FAMILIES.GOTHIC
        }
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: '#18191D',
          borderRadius: '12px',
          border: `1px solid rgba(255, 255, 255, 0.1)`
        }
      }
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#23252C',
          border: `1px solid rgba(255, 255, 255, 0.1)`,
          borderRadius: '6px',
          padding: '8px 12px'
        }
      }
    }
  }
})
