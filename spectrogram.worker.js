// spectrogram.worker.js — worker autônomo com FFT + processamento do espectrograma
// Coloque este arquivo no mesmo diretório do index.html para que Worker('spectrogram.worker.js') funcione.

(function(){class FFT{constructor(n){if(!Number.isInteger(Math.log2(n)))throw new Error('FFT size must be power of 2');this.n=n;this._buildReverseTable();this._buildTwiddles();}_buildReverseTable(){const n=this.n;const bits=Math.log2(n);this.rev=new Uint32Array(n);for(let i=0;i<n;i++){let x=i;let y=0;for(let j=0;j<bits;j++){y=(y<<1)|(x&1);x>>=1;}this.rev[i]=y;}}_buildTwiddles(){const n=this.n;this.cos=new Float32Array(n/2);this.sin=new Float32Array(n/2);for(let i=0;i<n/2;i++){const angle=-2*Math.PI*i/n;this.cos[i]=Math.cos(angle);this.sin[i]=Math.sin(angle);}}transform(real,imag){const n=this.n;const rev=this.rev;for(let i=0;i<n;i++){const j=rev[i];if(j>i){const tr=real[i];real[i]=real[j];real[j]=tr;const ti=imag[i];imag[i]=imag[j];imag[j]=ti;}}for(let size=2;size<=n;size<<=1){const half=size>>>1;const step=this.n/size;for(let i=0;i<n;i+=size){let k=0;for(let j=i;j<i+half;j++){const cos=this.cos[k];const sin=this.sin[k];const l=j+half;const tre=cos*real[l]-sin*imag[l];const tim=cos*imag[l]+sin*real[l];real[l]=real[j]-tre;imag[l]=imag[j]-tim;real[j]+=tre;imag[j]+=tim;k+=step;}}}}}if(typeof self!=='undefined')self.FFT=FFT;if(typeof window!=='undefined')window.FFT=FFT;})();

(function(){
  function hannWindow(size){const w=new Float32Array(size);if(size===1){w[0]=1.0;return w;}for(let i=0;i<size;i++){w[i]=0.5*(1-Math.cos((2*Math.PI*i)/(size-1)));}return w;}
  function hzToMel(f){return 2595*Math.log10(1+f/700);}
  function melToHz(m){return 700*(Math.pow(10,m/2595)-1);}
  function createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax){
    fmax=fmax||sampleRate/2;if(fmin<0)fmin=0;
    const melMin=hzToMel(fmin);const melMax=hzToMel(fmax);
    const meltabs=new Float32Array(nMels+2);
    for(let i=0;i<meltabs.length;i++){meltabs[i]=melToHz(melMin+(i/(nMels+1))*(melMax-melMin));}
    const binFreqs=new Float32Array(fftSize/2+1);
    for(let i=0;i<binFreqs.length;i++)binFreqs[i]=i*(sampleRate/fftSize);
    const fb=[];for(let m=0;m<nMels;m++){const lower=meltabs[m];const center=meltabs[m+1];const upper=meltabs[m+2];const filter=new Float32Array(binFreqs.length);const leftDen=(center-lower)||1e-9;const rightDen=(upper-center)||1e-9;for(let k=0;k<binFreqs.length;k++){const f=binFreqs[k];if(f>=lower&&f<=center){filter[k]=(f-lower)/leftDen;}else if(f>=center&&f<=upper){filter[k]=(upper-f)/rightDen;}else{filter[k]=0;}}fb.push(filter);}return fb;
  }
  function applyMelFilterbank(magSpectrum,melFilters){const nMels=melFilters.length;const out=new Float32Array(nMels);for(let m=0;m<nMels;m++){let sum=0;const filter=melFilters[m];for(let k=0;k<filter.length;k++){const f=filter[k];if(f){const v=magSpectrum[k];if(isFinite(v))sum+=v*f;}}out[m]=sum;}return out;}
  function toDb(array,ref=1.0){const out=new Float32Array(array.length);const amin=1e-10;for(let i=0;i<array.length;i++){const val=Math.max(array[i],amin);out[i]=20*Math.log10(val/ref);}return out;}
  function colorMap(v){if(!isFinite(v))v=0;if(v<0)v=0;if(v>1)v=1;const stops=[[68,1,84],[59,82,139],[33,144,140],[94,201,98],[253,231,37]];const t=v*(stops.length-1);const i=Math.floor(t);const frac=t-i;const a=stops[Math.max(0,Math.min(stops.length-1,i))];const b=stops[Math.max(0,Math.min(stops.length-1,i+1))];const r=Math.round(a[0]+(b[0]-a[0])*frac);const g=Math.round(a[1]+(b[1]-a[1])*frac);const bl=Math.round(a[2]+(b[2]-a[2])*frac);return[r,g,bl,255];}
  const fftCache=new Map();
  self.addEventListener('message',function(e){
    const data=e.data;
    if(!data||data.cmd!=='process')return;
    const samples=new Float32Array(data.audioBuffer);
    const sampleRate=data.sampleRate;
    const opts=data.options||{};
    const fftSize=opts.fftSize||2048;
    const hopSize=opts.hopSize||512;
    const nMels=Math.max(1,opts.nMels||64);
    const fmin=Math.max(0,opts.fmin||0);
    const fmax=opts.fmax||(sampleRate/2);
    const logScale=(opts.logScale!==undefined)?opts.logScale:true;
    const dynamicRange=opts.dynamicRange||80;
    const windowFunc=hannWindow(fftSize);
    const melFilters=createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax);
    let frames=Math.max(0,Math.floor((samples.length-fftSize)/hopSize)+1);
    if(frames<=0)frames=1;
    const width=Math.max(1,frames);
    const height=nMels;
    const imgW=Math.min(1200,Math.max(200,width));
    const imgH=Math.min(512,Math.max(100,height));
    const pixels=new Uint8ClampedArray(imgW*imgH*4);
    let fftInstance=null;
    if(typeof self.FFT==='function'){
      fftInstance=fftCache.get(fftSize);
      if(!fftInstance){fftInstance=new self.FFT(fftSize);fftCache.set(fftSize,fftInstance);}
    }
    const re=new Float32Array(fftSize);
    const im=new Float32Array(fftSize);
    const melSpec=new Float32Array(frames*nMels);
    const progressStep=Math.max(1,Math.floor(frames/20));
    for(let f=0;f<frames;f++){
      const offset=f*hopSize;
      for(let i=0;i<fftSize;i++){re[i]=(samples[offset+i]||0)*windowFunc[i];im[i]=0;}
      if(fftInstance){fftInstance.transform(re,im);}else{
        try{
          const outRe=new Float32Array(fftSize);
          const outIm=new Float32Array(fftSize);
          for(let k=0;k<fftSize;k++){let sumRe=0,sumIm=0;for(let n=0;n<fftSize;n++){const angle=-2*Math.PI*k*n/fftSize;const cos=Math.cos(angle),sin=Math.sin(angle);sumRe+=re[n]*cos-im[n]*sin;sumIm+=re[n]*sin+im[n]*cos;}outRe[k]=sumRe;outIm[k]=sumIm;}
          re.set(outRe);im.set(outIm);
        }catch(err){
          for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=0;
          continue;
        }
      }
      const half=Math.floor(fftSize/2)+1;
      const mag=new Float32Array(half);
      for(let k=0;k<half;k++){const rr=re[k],ii=im[k];const mVal=Math.sqrt((isFinite(rr)?rr*rr:0)+(isFinite(ii)?ii*ii:0));mag[k]=isFinite(mVal)?mVal:0;}
      const melFrame=applyMelFilterbank(mag,melFilters);
      for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=isFinite(melFrame[m])?melFrame[m]:0;
      if((f%progressStep)===0){self.postMessage({type:'progress',value:f/frames});}
    }
    self.postMessage({type:'progress',value:0.95});
    let melDb;
    if(logScale){
      let maxVal=0;
      for(let i=0;i<melSpec.length;i++)if(melSpec[i]>maxVal)maxVal=melSpec[i];
      const ref=maxVal>0?maxVal:1.0;
      melDb=toDb(melSpec,ref);
    }else{melDb=new Float32Array(melSpec);}
    let minVal=Infinity,maxVal=-Infinity;
    for(let i=0;i<melDb.length;i++){const v=melDb[i];if(!isFinite(v))continue;if(v<minVal)minVal=v;if(v>maxVal)maxVal=v;}
    if(!isFinite(minVal)||!isFinite(maxVal)){for(let i=0;i<melDb.length;i++)melDb[i]=0;minVal=0;maxVal=1;}
    if(logScale){
      const top=maxVal;const bottom=Math.max(maxVal-dynamicRange,minVal);const denom=(top-bottom)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-bottom)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }else{
      const denom=(maxVal-minVal)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-minVal)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }
    for(let x=0;x<imgW;x++){
      const frameIdx=Math.min(frames-1,Math.max(0,Math.floor(x*(frames/imgW))));
      const base=frameIdx*nMels;
      for(let y=0;y<imgH;y++){
        const melIdx=Math.floor((1-y/imgH)*(nMels-1));
        const idx=base+melIdx;
        const v=(idx>=0&&idx<melDb.length)?melDb[idx]:0;
        const c=colorMap(v);
        const p=(y*imgW+x)*4;
        pixels[p]=c[0];pixels[p+1]=c[1];pixels[p+2]=c[2];pixels[p+3]=255;
      }
      if((x%Math.max(1,Math.floor(imgW/30)))===0){self.postMessage({type:'progress',value:0.95+0.05*(x/imgW)});}
    }
    self.postMessage({type:'done',width:imgW,height:imgH,pixels:pixels.buffer},[pixels.buffer]);
  });
})();