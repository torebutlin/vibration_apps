#%%----------------------------------------------------------------------------
import numpy as np
import scipy.interpolate as si
import scipy.signal as ss
import scipy.io.wavfile as wf
import sounddevice as sd
import pydvma as dvma
import matplotlib
import time
import matplotlib.pyplot as plt
matplotlib.rcParams.update({'font.size': 16,'font.family':'serif'})
#%%----------------------------------------------------------------------------
sd.default.device = 'CoreAudio'  # Try this backend for Mac

def make_figure():
    fig,ax=plt.subplots(1,1, figsize = (8,6),dpi=115)
    ax.set_xlabel('Frequency (Hz)')
    ax.set_ylabel('Amplitude')
    return fig,ax

def show_devices():
    print(sd.query_devices())
    
def setup_devices(index_in=1,index_out=7):
    sd.default.device = [index_in,index_out]
    

def window_signal(fs,T,Tr):
    
    tr = np.arange(0,Tr,1/fs)
    Nr = len(tr)
    ramp = 0.5*(1-np.cos(np.pi/Tr * tr))
    
    t = np.arange(0,T,1/fs)
    N = len(t)
    win = np.hstack((ramp,np.ones(N-7*Nr),np.flip(ramp),np.zeros(5*Nr)))
    
    return t,win

def measure_tf1(fig,ax,fs=44100,T=2,fmin=20,fmax=500,NF=20,soundtest=False):
    # stepped sine
    
    #%% LOG DATA
    t = np.arange(0,T,1/fs)
    N = len(t)
    f = np.fft.rfftfreq(N,1/fs)
    freqs = np.linspace(fmin,fmax,NF)
    freqs = si.griddata(f,f,freqs,'nearest')
    G1 = np.zeros(len(freqs),dtype=complex)
    c = -1
    t, win = window_signal(fs, T, Tr=0.1)
    for freq in freqs:
        c += 1
        
        x = np.sin(2*np.pi*freq*t)
        x *= win
    
        print('Frequency = {} (Hz)'.format(freq))
        try:
            start_time = time.time()
            y = sd.playrec(x, samplerate=fs, channels=1, blocking=True,blocksize=1024, latency='low')
        except Exception as e:
            print(f"Error during playback/recording: {e}")
            continue

        X = np.fft.rfft(x)
        Y = np.fft.rfft(y[:, 0])
        
        IX = np.argmax(np.abs(X))
        IY = np.argmax(np.abs(Y))
        G = Y[IY] / X[IX]
        G1[c] = G
        if soundtest is True:
            ax.plot(freq, 20*np.log10(np.abs(G)), 'x', markeredgewidth=5, markersize=20, color=[0, 0, 0.8],alpha=0.2)
        else:
            ax.plot(freq, 20*np.log10(np.abs(G)), 'x', markeredgewidth=5, markersize=20, color=[0, 0, 0.8])
        fig.canvas.draw()
        fig.canvas.flush_events()
        
    settings = dvma.MySettings(fs=fs,channels=1)
    tfdata = dvma.TfData(freqs,G1,None,settings,test_name='stepped_sine')
        #ax.plot(freq,20*np.log10(np.abs(G1)),'x',markeredgewidth=5,markersize=20,color = [0, 0, 0.8],label="stepped sine")
        
        
    return tfdata

def measure_tf2(fig,ax,fs=44100,T=3,fmin=20,fmax=500):
    # sweep
    
    Tr = 0.1
    t,win = window_signal(fs,T,Tr=0.1)
    
    N = len(t)
    x = np.zeros(N)
    y = np.zeros(N)
    
    x = win*ss.chirp(t,fmin,T-6*Tr,fmax)
    
    
    f = np.fft.rfftfreq(N,1/fs)
    
    #%% LOG DATA
    print('Sweep: {} to {} (Hz)'.format(fmin,fmax))
    try:
        y = sd.playrec(x,samplerate=fs,channels=1,blocking=True,blocksize=1024, latency='low')
    except Exception as e:
        print(f"Error during playback/recording: {e}")
        
    
    X = np.fft.rfft(x)
    Y = np.fft.rfft(y[:,0])
    
    G2 = Y/X
    
    settings = dvma.MySettings(fs=fs,channels=1)
    
    tfdata = dvma.TfData(f,G2,None,settings,test_name='sweep')
    
    plot_tf(fig,ax,tfdata,fmin=fmin,fmax=fmax)
    
    return tfdata
    

def measure_tf3(fig,ax,fs=44100,T=3,fmin=20,fmax=500):
    # noise
    
    t,win = window_signal(fs,T,Tr=0.1)
    
    N = len(t)
    x = np.zeros(N)
    y = np.zeros(N)
    
    f = np.fft.rfftfreq(N,1/fs)
    
    XS = np.zeros(len(f))
    XS[(f > fmin) & (f < fmax)] = 1
    phase = 2*np.pi*np.random.rand(len(XS))
    XS = XS *np.exp(1j*phase)
    xs = np.fft.irfft(XS)
    
    
    xs = win*xs
    #xs = np.transpose(xs)
    x = xs/np.max(np.abs(xs))
    
    
    #%% LOG DATA
    print('Sweep: {} to {} (Hz)'.format(fmin,fmax))
    try:
        y = sd.playrec(x,samplerate=fs,channels=1,blocking=True,blocksize=1024, latency='low')
    except Exception as e:
        print(f"Error during playback/recording: {e}")
        
    X = np.fft.rfft(x)
    Y = np.fft.rfft(y[:,0])
    
    G3 = Y/X
    
    #%% STORE
    settings = dvma.MySettings(fs=fs,channels=1)
    tfdata = dvma.TfData(f,G3,None,settings,test_name='noise')
    
    plot_tf(fig,ax,tfdata,fmin=fmin,fmax=fmax)
    return tfdata

def measure_tf4(fig,ax,filename='sample2025-2026.wav',fs=44100,T=3,fmin=20,fmax=500):
    # signal
    fs,x = wf.read(filename)
    try:   
        y = sd.playrec(x,samplerate=fs,channels=1,blocking=True,blocksize=1024, latency='low')
    except Exception as e:
        print(f"Error during playback/recording: {e}")
        
    Nend = int(np.round(fs*T))
    x = x[0:Nend]
    y = y[0:Nend,0]
    
    N = len(x)
    
    f = np.fft.rfftfreq(N,1/fs)
    X = np.fft.rfft(x)
    Y = np.fft.rfft(y)
    G4 = Y/X
    
    #%% STORE
    settings = dvma.MySettings(fs=fs,channels=1)
    tfdata = dvma.TfData(f,G4,None,settings,test_name='sample')
    plot_tf(fig,ax,tfdata,fmin=fmin,fmax=fmax)
    
    return tfdata

def plot_tf(fig,ax,tfdata,fmin=20,fmax=500):
    
    G = tfdata.tf_data
    f = tfdata.freq_axis
    
    
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("Transfer Function (dB)")
    ax.set_xlim([0,fmax*1.1])
    ax.grid()
    

    ymin = np.min(20*np.log10(np.abs(G[(f>fmin) & (f<fmax)])))
    ymax = np.max(20*np.log10(np.abs(G[(f>fmin) & (f<fmax)])))
    ax.plot(f,20*np.log10(np.abs(G)),'-',linewidth=2,label=tfdata.test_name,alpha=0.5)
    ax.set_ylim([ymin-10,ymax+10])
    
    fig.canvas.draw()
    fig.canvas.flush_events()
    





    





